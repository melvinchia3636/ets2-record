import type {
  CancelledInfo,
  DeliveredInfo,
  GameEventInput,
  JobInfo,
  TelemetryFrame,
} from "./types.js";

export interface ProviderEvents {
  connected: () => void;
  disconnected: () => void;
  frame: (frame: TelemetryFrame) => void;
  "job-started": (job: JobInfo) => void;
  "job-delivered": (job: DeliveredInfo) => void;
  "job-cancelled": (job: CancelledInfo) => void;
  "game-event": (event: GameEventInput) => void;
}

export interface TelemetryProvider {
  start(): void;
  stop(): void;
  on<E extends keyof ProviderEvents>(event: E, listener: ProviderEvents[E]): this;
}

export abstract class BaseProvider implements TelemetryProvider {
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on<E extends keyof ProviderEvents>(event: E, listener: ProviderEvents[E]): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (...args: unknown[]) => void);
    return this;
  }

  protected emit<E extends keyof ProviderEvents>(
    event: E,
    ...args: Parameters<ProviderEvents[E]>
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) listener(...args);
  }

  abstract start(): void;
  abstract stop(): void;
}
