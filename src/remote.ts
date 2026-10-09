import { hostname } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { BaseProvider } from "./provider.js";
import type { TelemetryProvider } from "./provider.js";
import type {
  CancelledInfo,
  DeliveredInfo,
  GameEventInput,
  JobInfo,
  TelemetryFrame,
} from "./types.js";

export type RemoteMessage =
  | { type: "hello"; clientId: string; game: string }
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "frame"; frame: TelemetryFrame }
  | { type: "job-started"; job: JobInfo }
  | { type: "job-delivered"; job: DeliveredInfo }
  | { type: "job-cancelled"; job: CancelledInfo }
  | { type: "game-event"; event: GameEventInput };

export interface ServeOptions {
  host: string;
  port: number;
  token?: string;
  log?: (message: string) => void;
  onClient?: (clientId: string, remote: string | undefined) => void;
}

/** A TelemetryProvider fed by remote agents over WebSocket. */
export class WebSocketServerProvider extends BaseProvider {
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();
  private readonly log: (message: string) => void;

  constructor(private readonly opts: ServeOptions) {
    super();
    this.log = opts.log ?? (() => {});
  }

  start(): void {
    const server = new WebSocketServer({ host: this.opts.host, port: this.opts.port });
    this.wss = server;
    server.on("listening", () => {
      this.log(`listening on ws://${this.opts.host}:${this.opts.port}`);
    });
    server.on("connection", (socket, req) => {
      const url = new URL(req.url ?? "/", "ws://localhost");
      const token = url.searchParams.get("token") ?? undefined;
      if (this.opts.token && token !== this.opts.token) {
        socket.close(4001, "unauthorized");
        this.log(`rejected unauthenticated client from ${req.socket.remoteAddress}`);
        return;
      }
      this.clients.add(socket);
      const clientId = url.searchParams.get("client") ?? req.socket.remoteAddress ?? "unknown";
      this.log(`client connected: ${clientId} (${req.socket.remoteAddress})`);
      this.opts.onClient?.(clientId, req.socket.remoteAddress ?? undefined);

      socket.on("message", (data) => this.handle(socket, data.toString()));
      socket.on("close", () => {
        this.clients.delete(socket);
        this.log(`client disconnected: ${clientId}`);
        this.emit("disconnected");
      });
      socket.on("error", (err) => this.log(`client error (${clientId}): ${err.message}`));
    });
  }

  private handle(socket: WebSocket, raw: string): void {
    let msg: RemoteMessage;
    try {
      msg = JSON.parse(raw) as RemoteMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "hello":
        this.log(`hello from ${msg.clientId} (${msg.game})`);
        this.emit("connected");
        break;
      case "connected":
        this.emit("connected");
        break;
      case "disconnected":
        this.emit("disconnected");
        break;
      case "frame":
        this.emit("frame", msg.frame);
        break;
      case "job-started":
        this.emit("job-started", msg.job);
        break;
      case "job-delivered":
        this.emit("job-delivered", msg.job);
        break;
      case "job-cancelled":
        this.emit("job-cancelled", msg.job);
        break;
      case "game-event":
        this.emit("game-event", msg.event);
        break;
    }
  }

  stop(): void {
    for (const socket of this.clients) socket.close();
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
  }
}

export interface AgentOptions {
  server: string;
  token?: string;
  intervalMs: number;
  clientId?: string;
  log?: (message: string) => void;
}

/** Reads local telemetry and streams it to a remote recorder server. */
export class TelemetryAgent {
  private socket: WebSocket | null = null;
  private lastFrameAt = 0;
  private stopped = false;
  private providerStarted = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly clientId: string;
  private readonly log: (message: string) => void;

  constructor(
    private readonly provider: TelemetryProvider,
    private readonly opts: AgentOptions,
  ) {
    this.clientId = opts.clientId ?? hostname();
    this.log = opts.log ?? (() => {});
  }

  start(): void {
    this.provider.on("connected", () => this.send({ type: "connected" }));
    this.provider.on("disconnected", () => this.send({ type: "disconnected" }));
    this.provider.on("frame", (frame) => this.onFrame(frame));
    this.provider.on("job-started", (job) => this.send({ type: "job-started", job }));
    this.provider.on("job-delivered", (job) => this.send({ type: "job-delivered", job }));
    this.provider.on("job-cancelled", (job) => this.send({ type: "job-cancelled", job }));
    this.provider.on("game-event", (event) => this.send({ type: "game-event", event }));
    this.connect();
  }

  private url(): string {
    const u = new URL(this.opts.server);
    u.searchParams.set("client", this.clientId);
    if (this.opts.token) u.searchParams.set("token", this.opts.token);
    return u.toString();
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = new WebSocket(this.url());
    this.socket = socket;
    socket.on("open", () => {
      this.log(`connected to ${this.opts.server} as ${this.clientId}`);
      this.send({ type: "hello", clientId: this.clientId, game: "ets2" });
      if (!this.providerStarted) {
        this.providerStarted = true;
        this.provider.start();
      }
    });
    socket.on("close", () => {
      this.socket = null;
      if (this.stopped) return;
      this.log("server connection closed; retrying in 3s");
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    });
    socket.on("error", (err: Error) => this.log(`socket error: ${err.message}`));
  }

  private send(msg: RemoteMessage): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  private onFrame(frame: TelemetryFrame): void {
    if (frame.t - this.lastFrameAt < this.opts.intervalMs) return;
    this.lastFrameAt = frame.t;
    this.send({ type: "frame", frame });
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.provider.stop();
    this.socket?.close();
    this.socket = null;
  }
}
