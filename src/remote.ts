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
    this.provider.on("connected", () => this.enqueue({ type: "connected" }));
    this.provider.on("disconnected", () =>
      this.enqueue({ type: "disconnected" }),
    );
    this.provider.on("frame", (frame) => this.onFrame(frame));
    this.provider.on("job-started", (job) => {
      this.enqueue({
        type: "job-started",
        job: toWireJobStarted(job, this.lastFrame),
      });
      void this.flush();
    });
    this.provider.on("job-delivered", (job) => {
      this.enqueue({ type: "job-delivered", job: toWireDelivered(job) });
      void this.flush();
    });
    this.provider.on("job-cancelled", (job) => {
      this.enqueue({ type: "job-cancelled", job: toWireCancelled(job) });
      void this.flush();
    });
    this.provider.on("game-event", (event) =>
      this.enqueue({ type: "game-event", event: toWireGameEvent(event) }),
    );

    this.flushTimer = setInterval(() => void this.flush(), FLUSH_MS);
    this.provider.start();
  }

  private endpoint(): string {
    return `${this.opts.server.replace(/\/+$/, "")}/ets2-record/telemetry/ingest`;
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
        this.log(`buffer full; dropped ${this.dropped} message(s)`);
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
      const dropped = this.dropped;
      this.dropped = 0;
      this.log(
        `sent ${batch.length} message(s)${dropped ? ` (${dropped} dropped)` : ""}`,
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
      this.log(`send failed: ${(err as Error).message}; retrying`);
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
    await this.flush();
  }
}
