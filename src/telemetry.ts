import type { SCSSDKTelemetry } from "trucksim-telemetry";
import { BaseProvider } from "./provider.js";
import type { Game, JobInfo, TelemetryFrame } from "./types.js";

const RAD_TO_DEG = 180 / Math.PI;
const MS_TO_KMH = 3.6;

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

function jobInfo(data: SCSSDKTelemetry): JobInfo {
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
  };
}

function defaultSharedMemoryName(): string {
  return process.platform === "win32" ? "Local\\SCSTelemetry" : "/SCSTelemetry";
}

export class LiveProvider extends BaseProvider {
  private telemetry: ReturnType<typeof import("trucksim-telemetry").truckSimTelemetry> | null = null;
  private lastJob: JobInfo | null = null;

  constructor(private readonly sharedMemoryName?: string) {
    super();
  }

  start(): void {
    void this.boot();
  }

  private async boot(): Promise<void> {
    const mod = await import("trucksim-telemetry");
    const telemetry = mod.truckSimTelemetry({
      sharedMemoryName: this.sharedMemoryName ?? defaultSharedMemoryName(),
      onUpdate: (data) => {
        // The library polls at ~60Hz even when the game isn't running, reporting
        // stale data. Only emit frames while the game instance is actually active.
        if (!data.sdkActive) return;
        this.emit("frame", toFrame(data, Date.now()));
      },
    });
    this.telemetry = telemetry;

    telemetry.on("connected", () => this.emit("connected"));
    telemetry.on("disconnected", () => this.emit("disconnected"));

    telemetry.on("job-started", (data) => {
      const job = jobInfo(data as unknown as SCSSDKTelemetry);
      this.lastJob = job;
      this.emit("job-started", job);
    });

    telemetry.on("job-delivered", (data) => {
      const raw = data as unknown as SCSSDKTelemetry;
      const base = this.lastJob ?? jobInfo(raw);
      this.emit("job-delivered", {
        ...base,
        finishedGameMin: raw.jobFinishedTime,
        deliveryTimeMin: raw.jobDeliveredDeliveryTime,
        distanceKm: raw.jobDeliveredDistanceKm,
        cargoDamage: raw.jobDeliveredCargoDamage,
        revenue: toNumber(raw.jobDeliveredRevenue),
        xp: raw.jobDeliveredEarnedXp,
        autopark: raw.jobDeliveredAutoparkUsed,
        autoload: raw.jobDeliveredAutoloadUsed,
      });
      this.lastJob = null;
    });

    telemetry.on("job-cancelled", (data) => {
      const raw = data as unknown as SCSSDKTelemetry;
      const base = this.lastJob ?? jobInfo(raw);
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
