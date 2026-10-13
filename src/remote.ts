import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import type { TelemetryProvider } from "./provider.js";
import {
  listScreenshotFiles,
  mimeFor,
  parseCapturedAt,
  ScreenshotWatcher,
  type CapturedScreenshot,
} from "./screenshots.js";
import { ScreenshotSpool } from "./spool.js";
import type { ScreenshotMeta, TelemetryFrame } from "./types.js";
import {
  toWireCancelled,
  toWireDelivered,
  toWireFrame,
  toWireGameEvent,
  toWireJobStarted,
  type AgentMessage,
} from "./wire.js";

export interface AgentOptions {
  /** LifeForge API base URL, e.g. `http://host:3636`. */
  server: string;
  token?: string;
  intervalMs: number;
  clientId?: string;
  /** Max telemetry messages buffered while the server is unreachable. */
  maxPending?: number;
  /** Folders to watch for in-game screenshots; omit or empty to disable. */
  screenshotDirs?: string[];
  /** Directory for the durable screenshot upload queue. */
  spoolDir?: string;
  /** Upload all existing screenshots once before starting the agent. */
  backfill?: boolean;
  /** Path of the backfill ledger (records files already uploaded). */
  ledgerPath?: string;
  log?: (message: string) => void;
}

/** How often buffered messages are flushed to the server. */
const FLUSH_MS = 5000;
/** Max messages sent in a single HTTP request. */
const MAX_BATCH = 2000;
/** Delay before retrying a failed batch. */
const RETRY_MS = 3000;

const MESSAGE_LABELS: Record<AgentMessage["type"], string> = {
  connected: "game connected",
  disconnected: "game disconnected",
  frame: "frame",
  "job-started": "job started",
  "job-delivered": "job delivered",
  "job-cancelled": "job cancelled",
  "game-event": "game event",
};

/** Summarises a batch like `42× frame, 1× job started`. */
function describeBatch(batch: AgentMessage[]): string {
  const counts = new Map<AgentMessage["type"], number>();

  for (const message of batch) {
    counts.set(message.type, (counts.get(message.type) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([type, count]) => `${count}× ${MESSAGE_LABELS[type]}`)
    .join(", ");
}

/** SHA-256 of a file, streamed so large screenshots aren't held in memory. */
function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Reads local telemetry and streams it to a LifeForge recorder server over HTTP. */
export class TelemetryAgent {
  private pending: AgentMessage[] = [];
  private lastFrameAt = 0;
  private lastFrame: TelemetryFrame | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private stopped = false;
  private dropped = 0;
  /** null until the first request settles, then whether the recorder is reachable. */
  private online: boolean | null = null;
  /** Recent frames (last ~60s) for matching a screenshot to its position. */
  private readonly recentFrames: TelemetryFrame[] = [];
  private screenshotWatcher: ScreenshotWatcher | null = null;
  private readonly screenshotDirs: string[];
  private readonly spool: ScreenshotSpool;
  private readonly ledgerPath: string;
  private draining = false;
  private readonly maxPending: number;
  private readonly clientId: string;
  private readonly log: (message: string) => void;

  constructor(
    private readonly provider: TelemetryProvider,
    private readonly opts: AgentOptions,
  ) {
    this.clientId = opts.clientId ?? hostname();
    this.maxPending = opts.maxPending ?? 1_000_000;
    this.log = opts.log ?? (() => {});
    this.screenshotDirs = opts.screenshotDirs ?? [];
    const stateDir = path.join(homedir(), ".truckers-log");
    this.spool = new ScreenshotSpool(opts.spoolDir ?? path.join(stateDir, "spool"));
    this.ledgerPath = opts.ledgerPath ?? path.join(stateDir, "backfill.json");
  }

  async start(): Promise<void> {
    this.log(
      `watching local telemetry as "${this.clientId}" → ${this.endpoint()}`,
    );

    this.provider.on("connected", () => {
      this.log("game telemetry connected");
      this.enqueue({ type: "connected" });
    });
    this.provider.on("disconnected", () => {
      this.log("game telemetry disconnected");
      this.enqueue({ type: "disconnected" });
    });
    this.provider.on("frame", (frame) => this.onFrame(frame));
    this.provider.on("job-started", (job) => {
      this.log(
        `job started — ${job.cargo || "unknown cargo"} (${job.citySrc || "?"} → ${job.cityDst || "?"}, ${job.plannedDistanceKm} km)`,
      );
      this.enqueue({
        type: "job-started",
        job: toWireJobStarted(job, this.lastFrame),
      });
      void this.flush();
    });
    this.provider.on("job-delivered", (job) => {
      this.log(
        `job delivered — ${job.distanceKm} km, revenue ${job.revenue}, ${job.xp} XP`,
      );
      this.enqueue({ type: "job-delivered", job: toWireDelivered(job) });
      void this.flush();
    });
    this.provider.on("job-cancelled", (job) => {
      this.log(`job cancelled — penalty ${job.penalty}`);
      this.enqueue({ type: "job-cancelled", job: toWireCancelled(job) });
      void this.flush();
    });
    this.provider.on("game-event", (event) => {
      const detail = event.detail ? `: ${event.detail}` : "";
      const amount = event.amount ? ` (${event.amount})` : "";

      this.log(`event — ${event.kind}${detail}${amount}`);
      this.enqueue({ type: "game-event", event: toWireGameEvent(event) });
    });

    this.flushTimer = setInterval(() => void this.flush(), FLUSH_MS);

    if (this.screenshotDirs.length > 0) {
      this.screenshotWatcher = new ScreenshotWatcher(
        this.screenshotDirs,
        this.log,
      );
      this.screenshotWatcher.on((shot) => void this.onScreenshot(shot));
      await this.startScreenshots();
    }

    if (!this.stopped) this.provider.start();
  }

  private endpoint(): string {
    return `${this.opts.server.replace(/\/+$/, "")}/truckers-log/telemetry/ingest`;
  }

  private onFrame(frame: TelemetryFrame): void {
    this.lastFrame = frame;

    this.recentFrames.push(frame);
    const cutoff = frame.t - 60_000;
    while (this.recentFrames.length > 0 && this.recentFrames[0]!.t < cutoff) {
      this.recentFrames.shift();
    }

    if (frame.t - this.lastFrameAt < this.opts.intervalMs) return;
    this.lastFrameAt = frame.t;
    this.enqueue({ type: "frame", frame: toWireFrame(frame) });
  }

  private async startScreenshots(): Promise<void> {
    await this.spool.init();

    if (this.opts.backfill) {
      const baseline = await this.backfill();

      await this.screenshotWatcher?.start({ baseline });
    } else {
      await this.screenshotWatcher?.start();
    }

    await this.drainSpool();
  }

  /** Matches a captured screenshot to the closest recent frame and queues it. */
  private async onScreenshot(shot: CapturedScreenshot): Promise<void> {
    const frame = this.nearestFrame(shot.capturedAt);

    let contentHash: string;

    try {
      contentHash = await hashFile(shot.path);
    } catch (err) {
      this.log(`failed to hash screenshot: ${(err as Error).message}`);
      return;
    }

    const meta: ScreenshotMeta = {
      filename: shot.filename,
      capturedAt: shot.capturedAt,
      mime: shot.mime,
      size: shot.size,
      contentHash,
      game: frame?.game ?? "unknown",
      gameMin: frame?.gameMin ?? null,
      x: frame?.x ?? null,
      y: frame?.y ?? null,
      z: frame?.z ?? null,
      headingDeg: frame?.headingDeg ?? null,
      speedKmh: frame ? frame.speed * 3.6 : null,
      truckId: frame?.truckId ?? "",
      truckName: frame?.truckName ?? "",
      truckBrand: frame?.truckBrand ?? "",
      truckPlate: frame?.truckPlate ?? "",
    };

    this.log(
      `screenshot — ${shot.filename}${frame ? "" : " (no telemetry frame)"}`,
    );

    try {
      await this.spool.add(shot.path, meta);
    } catch (err) {
      this.log(`failed to queue screenshot: ${(err as Error).message}`);
      return;
    }

    await this.drainSpool();
  }

  private nearestFrame(at: number): TelemetryFrame | null {
    let best: TelemetryFrame | null = null;
    let bestDiff = Infinity;
    for (const frame of this.recentFrames) {
      const diff = Math.abs(frame.t - at);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = frame;
      }
    }
    return best ?? this.lastFrame;
  }

  private screenshotEndpoint(): string {
    return `${this.opts.server.replace(/\/+$/, "")}/truckers-log/screenshots/upload`;
  }

  /** Uploads queued screenshots oldest-first, stopping on the first failure. */
  private async drainSpool(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const entry of await this.spool.list()) {
        const uploaded = await this.uploadScreenshot(entry);
        if (!uploaded) break;
        await this.spool.remove(entry);
        this.log(`screenshot uploaded — ${entry.meta.filename}`);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Uploads every screenshot already in the watched folders once. Returns the
   * set of files seen, so the watcher treats them as handled while still
   * capturing anything created during the scan.
   */
  private async backfill(): Promise<Set<string>> {
    const files = await listScreenshotFiles(this.screenshotDirs);
    const baseline = new Set(files);
    const ledger = await this.readLedger();
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;

    this.log(`backfill: ${files.length} screenshot(s) found`);

    for (const full of files) {
      if (this.stopped) break;

      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.size <= 0) continue;

      const previous = ledger[full];
      if (
        previous &&
        previous.size === stat.size &&
        previous.mtime === stat.mtimeMs
      ) {
        skipped++;
        continue;
      }

      const filename = path.basename(full);
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(full);
      } catch {
        continue;
      }

      const meta: ScreenshotMeta = {
        filename,
        capturedAt: parseCapturedAt(filename, stat.mtimeMs),
        mime: mimeFor(filename),
        size: stat.size,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        game: "unknown",
        gameMin: null,
        x: null,
        y: null,
        z: null,
        headingDeg: null,
        speedKmh: null,
        truckId: "",
        truckName: "",
        truckBrand: "",
        truckPlate: "",
      };

      if (await this.uploadBytes(bytes, meta)) {
        ledger[full] = { size: stat.size, mtime: stat.mtimeMs };
        uploaded++;
      } else {
        await this.spool.add(full, meta).catch(() => {});
        failed++;
      }
    }

    await this.writeLedger(ledger);
    this.log(
      `backfill complete — ${uploaded} uploaded, ${skipped} skipped, ${failed} queued`,
    );

    if (failed > 0) await this.drainSpool();

    return baseline;
  }

  private async readLedger(): Promise<
    Record<string, { size: number; mtime: number }>
  > {
    try {
      return JSON.parse(await fs.readFile(this.ledgerPath, "utf8"));
    } catch {
      return {};
    }
  }

  private async writeLedger(
    ledger: Record<string, { size: number; mtime: number }>,
  ): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.ledgerPath), { recursive: true });
      await fs.writeFile(this.ledgerPath, JSON.stringify(ledger), "utf8");
    } catch (err) {
      this.log(`failed to write backfill ledger: ${(err as Error).message}`);
    }
  }

  private async uploadScreenshot(entry: {
    meta: ScreenshotMeta;
    imagePath: string;
  }): Promise<boolean> {
    try {
      const bytes = await fs.readFile(entry.imagePath);
      return await this.uploadBytes(bytes, entry.meta);
    } catch (err) {
      this.log(`screenshot upload failed (${(err as Error).message}) — queued`);
      return false;
    }
  }

  private async uploadBytes(
    bytes: Buffer,
    meta: ScreenshotMeta,
  ): Promise<boolean> {
    try {
      const form = new FormData();
      form.set("token", this.opts.token ?? "");
      form.set("clientId", this.clientId);
      form.set("metadata", JSON.stringify(meta));
      form.set("file", new Blob([bytes], { type: meta.mime }), meta.filename);
      const res = await fetch(this.screenshotEndpoint(), {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (err) {
      this.log(`screenshot upload failed (${(err as Error).message})`);
      return false;
    }
  }

  private enqueue(message: AgentMessage): void {
    this.pending.push(message);
    while (this.pending.length > this.maxPending) {
      this.pending.shift();
      this.dropped++;
      if (this.dropped % 1000 === 1) {
        this.log(
          `buffer full (${this.maxPending}) — dropped ${this.dropped} oldest message(s)`,
        );
      }
    }
  }

  /** Sends the buffered messages. A 2xx response acknowledges (drops) them. */
  async flush(): Promise<void> {
    if (this.flushing || this.pending.length === 0) return;
    this.flushing = true;
    const batch = this.pending.splice(0, MAX_BATCH);
    try {
      const res = await fetch(this.endpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: this.opts.token ?? "",
          clientId: this.clientId,
          messages: batch,
        }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      if (this.online !== true) {
        this.log(
          this.online === false
            ? "recorder reachable again — resuming upload"
            : `connected to recorder at ${this.opts.server}`,
        );
        this.online = true;
      }

      void this.drainSpool();

      const dropped = this.dropped;
      this.dropped = 0;

      const queued = this.pending.length
        ? `, ${this.pending.length} queued`
        : "";
      const lost = dropped ? `, dropped ${dropped}` : "";

      this.log(
        `sent ${batch.length} message${batch.length === 1 ? "" : "s"} [${describeBatch(batch)}]${lost}${queued}`,
      );

      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
    } catch (err) {
      // Put the batch back at the front, preserving order.
      this.pending = [...batch, ...this.pending];
      while (this.pending.length > this.maxPending) {
        this.pending.shift();
        this.dropped++;
      }

      if (this.online !== false) {
        this.online = false;
        this.log(
          `recorder unreachable (${(err as Error).message}) — buffering ${this.pending.length} message(s), retrying every ${RETRY_MS / 1000}s`,
        );
      }

      if (!this.retryTimer && !this.stopped) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.flush();
        }, RETRY_MS);
      }
    } finally {
      this.flushing = false;
    }
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.screenshotWatcher?.stop();
    this.screenshotWatcher = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopped = true;
    this.provider.stop();

    if (this.pending.length > 0) {
      this.log(
        `flushing ${this.pending.length} buffered message(s) before exit`,
      );
    }

    await this.flush();
  }
}
