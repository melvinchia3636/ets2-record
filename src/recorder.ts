import type { Store } from "./db.js";
import type { TelemetryProvider } from "./provider.js";
import type { SampleRow, TelemetryFrame } from "./types.js";

const KPH = 3.6;

export interface RecorderOptions {
  intervalMs: number;
  flushMs: number;
  staleMs?: number;
  log?: (message: string) => void;
}

type Anchor = {
  t: number;
  game: string;
  truckId: string;
  truckName: string;
  truckBrand: string;
  truckPlate: string;
};

export class Recorder {
  private sessionId: number | null = null;
  private activeJobId: number | null = null;
  private sampleTripId: number | null = null;
  private lastFrame: TelemetryFrame | null = null;
  private buffer: SampleRow[] = [];
  private lastSampleAt = 0;
  private metaFilled = false;
  private jobMetaFilled = true;
  private flushTimer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private log: (message: string) => void;

  constructor(
    private readonly store: Store,
    private readonly provider: TelemetryProvider,
    private readonly opts: RecorderOptions,
  ) {
    this.log = opts.log ?? (() => {});
  }

  start(): void {
    this.provider.on("connected", () => {
      this.log("telemetry connected");
      if (this.sessionId === null) {
        this.sessionId = this.store.createSession(this.anchor());
        this.sampleTripId = this.sessionId;
        this.metaFilled = false;
        this.log(`session started #${this.sessionId}`);
      }
    });

    this.provider.on("disconnected", () => {
      this.log("telemetry disconnected");
      if (this.sessionId !== null) {
        this.flush();
        this.store.finishSession(this.sessionId, this.lastFrame?.gameMin ?? null);
        this.log(`session #${this.sessionId} ended`);
        this.sessionId = null;
        this.sampleTripId = null;
        this.activeJobId = null;
      }
    });

    this.provider.on("frame", (frame) => this.onFrame(frame));

    this.provider.on("job-started", (job) => {
      this.flush();
      if (this.activeJobId !== null) {
        this.store.interruptTrip(this.activeJobId);
        this.log(`superseded active job #${this.activeJobId}`);
      }
      this.activeJobId = this.store.createTrip(job, this.anchor(), this.sessionId);
      this.jobMetaFilled = false;
      this.log(
        `job started #${this.activeJobId}: ${job.cargo} ${job.citySrc} -> ${job.cityDst} (${job.plannedDistanceKm} km)`,
      );
    });

    this.provider.on("job-delivered", (d) => {
      if (this.activeJobId === null) return;
      this.flush();
      this.store.finalizeDelivered(this.activeJobId, d);
      this.log(
        `job delivered #${this.activeJobId}: ${d.distanceKm} km, revenue ${d.revenue}, xp ${d.xp}`,
      );
      this.activeJobId = null;
    });

    this.provider.on("job-cancelled", (c) => {
      if (this.activeJobId === null) return;
      this.flush();
      this.store.finalizeCancelled(this.activeJobId, c);
      this.log(`job cancelled #${this.activeJobId} (penalty ${c.penalty})`);
      this.activeJobId = null;
    });

    this.provider.on("game-event", (event) => {
      this.store.insertEvent(this.activeJobId ?? this.sessionId, event);
      this.log(`event ${event.kind} ${event.detail} ${event.amount || ""}`.trim());
    });

    this.flushTimer = setInterval(() => this.flush(), this.opts.flushMs);
    this.staleTimer = setInterval(() => this.cleanupStale(), 60_000);
    this.provider.start();
  }

  private cleanupStale(): void {
    if (this.opts.staleMs === undefined) return;
    const exclude = [this.sessionId, this.activeJobId].filter((id): id is number => id !== null);
    const n = this.store.markStaleActiveTrips(this.opts.staleMs, exclude);
    if (n > 0) this.log(`reaped ${n} stale active trip(s)`);
  }

  private anchor(): Anchor {
    if (this.lastFrame) return this.lastFrame;
    return { t: Date.now(), game: "unknown", truckId: "", truckName: "", truckBrand: "", truckPlate: "" };
  }

  private onFrame(frame: TelemetryFrame): void {
    this.lastFrame = frame;
    if (this.sampleTripId === null) return;
    if (!this.metaFilled) {
      this.store.updateTripMeta(this.sampleTripId, frame);
      this.metaFilled = true;
    }
    if (this.activeJobId !== null && !this.jobMetaFilled) {
      this.store.updateTripMeta(this.activeJobId, frame);
      this.jobMetaFilled = true;
    }
    if (frame.t - this.lastSampleAt < this.opts.intervalMs) return;
    this.lastSampleAt = frame.t;
    this.buffer.push(this.toSample(this.sampleTripId, frame));
    if (this.buffer.length >= 600) this.flush();
  }

  private toSample(tripId: number, f: TelemetryFrame): SampleRow {
    return {
      tripId,
      tMs: f.t,
      gameMin: f.gameMin,
      speedKmh: f.speed * KPH,
      rpm: f.rpm,
      gear: f.gear,
      throttle: f.throttle,
      brake: f.brake,
      steer: f.steer,
      clutch: f.clutch,
      fuelL: f.fuel,
      adblueL: f.adblue,
      odometerKm: f.odometerKm,
      cargoDamage: f.cargoDamage,
      x: f.x,
      y: f.y,
      z: f.z,
      headingDeg: f.headingDeg,
      cruiseControl: f.cruiseControl,
      engineOn: f.engineOn,
      parkBrake: f.parkBrake,
    };
  }

  flush(): void {
    if (this.sampleTripId !== null && this.buffer.length > 0) {
      this.store.insertSamples(this.buffer);
    }
    this.buffer = [];
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = null;
    this.provider.stop();
    this.flush();
    if (this.activeJobId !== null) this.store.interruptTrip(this.activeJobId);
    if (this.sessionId !== null) this.store.interruptTrip(this.sessionId);
  }
}
