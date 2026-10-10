import { hostname } from "node:os";
import type { TelemetryProvider } from "./provider.js";
import type { TelemetryFrame } from "./types.js";
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
  }

  start(): void {
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
    this.provider.start();
  }

  private endpoint(): string {
    return `${this.opts.server.replace(/\/+$/, "")}/truckers-log/telemetry/ingest`;
  }

  private onFrame(frame: TelemetryFrame): void {
    this.lastFrame = frame;
    if (frame.t - this.lastFrameAt < this.opts.intervalMs) return;
    this.lastFrameAt = frame.t;
    this.enqueue({ type: "frame", frame: toWireFrame(frame) });
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
