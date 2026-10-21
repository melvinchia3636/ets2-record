import type { SCSSDKTelemetry } from "trucksim-telemetry";
import { BaseProvider } from "./provider.js";
import type {
  DeliveredInfo,
  Game,
  JobInfo,
  TelemetryFrame,
} from "./types.js";

const RAD_TO_DEG = 180 / Math.PI;
const MS_TO_KMH = 3.6;

/** How long to wait for the SDK to fill in the delivery summary. */
const DELIVERY_SUMMARY_WAIT_MS = 3000;

function toNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function mapGame(game: number): Game {
  if (game === 1) return "ets2";
  if (game === 2) return "ats";
  return "unknown";
}

export function toFrame(data: SCSSDKTelemetry, now: number): TelemetryFrame {
  return {
    t: now,
    gameMin: data.timeAbs,
    speed: data.speed,
    rpm: data.engineRpm,
    gear: data.gear,
    throttle: data.gameThrottle,
    brake: data.gameBrake,
    steer: data.gameSteer,
    clutch: data.gameClutch,
    fuel: data.fuel,
    adblue: data.adblue,
    odometerKm: data.truckOdometer,
    cargoDamage: data.cargoDamage,
    engineOn: data.engineEnabled,
    parkBrake: data.parkBrake,
    cruiseControl: data.cruiseControl,
    lightsBeamLow: data.lightsBeamLow,
    routeDistanceM: data.routeDistance,
    routeTimeS: data.routeTime,
    restStopMin: data.restStop,
    x: data.coordinateX,
    y: data.coordinateY,
    z: data.coordinateZ,
    headingDeg: data.rotationY * RAD_TO_DEG,
    game: mapGame(data.game),
    truckId: data.truckId,
    truckName: data.truckName,
    truckBrand: data.truckBrand,
    truckPlate: data.truckLicensePlate,
    onJob: data.onJob,
  };
}

function trailerInfo(data: SCSSDKTelemetry | null | undefined) {
  const trailers = data?.trailers ?? []
  const trailer =
    trailers.find((t) => t.attached && t.bodyType) ??
    trailers.find((t) => t.attached) ??
    trailers.find((t) => t.bodyType)

  return {
    trailerBodyType: trailer?.bodyType ?? "",
    trailerId: trailer?.id ?? "",
    trailerName: trailer?.name ?? "",
    trailerBrand: trailer?.brand ?? "",
  }
}

function jobInfo(
  data: SCSSDKTelemetry,
  fallback?: SCSSDKTelemetry | null,
): JobInfo {
  const trailer = trailerInfo(data)
  const fallbackTrailer = trailerInfo(fallback)

  return {
    cargo: data.cargo,
    cargoId: data.cargoId,
    cargoMassKg: data.cargoMass,
    citySrc: data.citySrc,
    citySrcId: data.citySrcId,
    compSrc: data.compSrc,
    compSrcId: data.compSrcId,
    cityDst: data.cityDst,
    cityDstId: data.cityDstId,
    compDst: data.compDst,
    compDstId: data.compDstId,
    jobMarket: data.jobMarket,
    specialJob: data.specialJob,
    unitCount: data.unitCount,
    unitMassKg: data.unitMass,
    plannedDistanceKm: data.plannedDistanceKm,
    income: toNumber(data.jobIncome),
    startingGameMin: data.jobStartingTime,
    deliveryWindowGameMin: data.timeAbsDelivery,
    trailerBodyType: trailer.trailerBodyType || fallbackTrailer.trailerBodyType,
    trailerId: trailer.trailerId || fallbackTrailer.trailerId,
    trailerName: trailer.trailerName || fallbackTrailer.trailerName,
    trailerBrand: trailer.trailerBrand || fallbackTrailer.trailerBrand,
  };
}

function defaultSharedMemoryName(): string {
  return process.platform === "win32" ? "Local\\SCSTelemetry" : "/SCSTelemetry";
}

export class LiveProvider extends BaseProvider {
  private telemetry: ReturnType<typeof import("trucksim-telemetry").truckSimTelemetry> | null = null;
  private lastJob: JobInfo | null = null;
  private pendingDelivery: { job: DeliveredInfo; startedAt: number } | null = null;

  constructor(private readonly sharedMemoryName?: string) {
    super();
  }

  start(): void {
    void this.boot();
  }

  /**
   * The SDK can flip `jobDelivered` before it fills in the delivery summary
   * (distance, revenue, XP). Hold the message briefly and pick the values up
   * from subsequent frames so the job isn't stored with zeros.
   */
  private flushPendingDelivery(
    data?: SCSSDKTelemetry | null,
    force = false,
  ): void {
    const pending = this.pendingDelivery;

    if (!pending) return;

    if (data) {
      pending.job = {
        ...pending.job,
        finishedGameMin: data.jobFinishedTime || pending.job.finishedGameMin,
        deliveryTimeMin:
          data.jobDeliveredDeliveryTime || pending.job.deliveryTimeMin,
        distanceKm: data.jobDeliveredDistanceKm || pending.job.distanceKm,
        cargoDamage: data.jobDeliveredCargoDamage || pending.job.cargoDamage,
        revenue: toNumber(data.jobDeliveredRevenue) || pending.job.revenue,
        xp: data.jobDeliveredEarnedXp || pending.job.xp,
        autopark: data.jobDeliveredAutoparkUsed || pending.job.autopark,
        autoload: data.jobDeliveredAutoloadUsed || pending.job.autoload,
      };
    }

    const ready =
      pending.job.distanceKm > 0 &&
      pending.job.revenue > 0 &&
      pending.job.xp > 0;

    if (
      !force &&
      !ready &&
      Date.now() - pending.startedAt < DELIVERY_SUMMARY_WAIT_MS
    ) {
      return;
    }

    this.emit("job-delivered", pending.job);
    this.pendingDelivery = null;
    this.lastJob = null;
  }

  private async boot(): Promise<void> {
    const mod = await import("trucksim-telemetry");
    const telemetry = mod.truckSimTelemetry({
      sharedMemoryName: this.sharedMemoryName ?? defaultSharedMemoryName(),
      onUpdate: (data) => {
        // The library polls at ~60Hz even when the game isn't running, reporting
        // stale data. Only emit frames while the game instance is actually active.
        if (!data.sdkActive) return;
        this.flushPendingDelivery(data);
        this.emit("frame", toFrame(data, Date.now()));
      },
    });
    this.telemetry = telemetry;

    telemetry.on("connected", () => this.emit("connected"));
    telemetry.on("disconnected", () => {
      this.flushPendingDelivery(null, true);
      this.emit("disconnected");
    });

    telemetry.on("job-started", (data) => {
      this.flushPendingDelivery(null, true);
      const job = jobInfo(
        data as unknown as SCSSDKTelemetry,
        telemetry.data.current,
      );
      this.lastJob = job;
      this.emit("job-started", job);
    });

    telemetry.on("job-delivered", (data) => {
      const raw = data as unknown as SCSSDKTelemetry;
      const base = this.lastJob ?? jobInfo(raw, telemetry.data.current);
      this.pendingDelivery = {
        startedAt: Date.now(),
        job: {
          ...base,
          finishedGameMin: raw.jobFinishedTime,
          deliveryTimeMin: raw.jobDeliveredDeliveryTime,
          distanceKm: raw.jobDeliveredDistanceKm,
          cargoDamage: raw.jobDeliveredCargoDamage,
          revenue: toNumber(raw.jobDeliveredRevenue),
          xp: raw.jobDeliveredEarnedXp,
          autopark: raw.jobDeliveredAutoparkUsed,
          autoload: raw.jobDeliveredAutoloadUsed,
        },
      };
      this.flushPendingDelivery(telemetry.data.current);
    });

    telemetry.on("job-cancelled", (data) => {
      this.flushPendingDelivery(null, true);
      const raw = data as unknown as SCSSDKTelemetry;
      const base = this.lastJob ?? jobInfo(raw, telemetry.data.current);
      this.emit("job-cancelled", { ...base, penalty: toNumber(raw.jobCancelledPenalty) });
      this.lastJob = null;
    });

    telemetry.on("fine", (e) =>
      this.emit("game-event", {
        kind: "fine",
        gameMin: telemetry.data.current.timeAbs,
        amount: toNumber(e.fineAmount),
        detail: e.fineOffence,
      }),
    );
    telemetry.on("refuel-paid", (e) =>
      this.emit("game-event", {
        kind: "refuel",
        gameMin: telemetry.data.current.timeAbs,
        amount: 0,
        detail: `${e.refuelAmount.toFixed(1)} L`,
      }),
    );
    telemetry.on("tollgate", (e) =>
      this.emit("game-event", {
        kind: "tollgate",
        gameMin: telemetry.data.current.timeAbs,
        amount: toNumber(e.tollgatePayAmount),
        detail: "",
      }),
    );
    telemetry.on("ferry", (e) =>
      this.emit("game-event", {
        kind: "ferry",
        gameMin: telemetry.data.current.timeAbs,
        amount: toNumber(e.ferryPayAmount),
        detail: `${e.ferrySourceName} -> ${e.ferryTargetName}`,
      }),
    );
    telemetry.on("train", (e) =>
      this.emit("game-event", {
        kind: "train",
        gameMin: telemetry.data.current.timeAbs,
        amount: toNumber(e.trainPayAmount),
        detail: `${e.trainSourceName} -> ${e.trainTargetName}`,
      }),
    );

    const initial = telemetry.data.current;
    if (initial.sdkActive) {
      this.emit("connected");
      if (initial.onJob) {
        const job = jobInfo(initial);
        this.lastJob = job;
        this.emit("job-started", job);
      }
    }
  }

  stop(): void {}
}

export { MS_TO_KMH };
