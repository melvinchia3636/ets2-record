import type {
  CancelledInfo,
  DeliveredInfo,
  GameEventInput,
  JobInfo,
  TelemetryFrame,
} from "./types.js";

/** Payload shapes understood by the LifeForge `truckers-log` ingest endpoint. */
export interface WireFrame {
  t_ms: number;
  game_min: number;
  speed_kmh: number;
  rpm: number;
  gear: number;
  throttle: number;
  brake: number;
  steer: number;
  clutch: number;
  fuel_l: number;
  adblue_l: number;
  odometer_km: number;
  cargo_damage: number;
  x: number;
  y: number;
  z: number;
  heading_deg: number;
  cruise_control: boolean;
  engine_on: boolean;
  park_brake: boolean;
  game: string;
  truck_id: string;
  truck_name: string;
  truck_brand: string;
  truck_plate: string;
}

export interface WireJobStarted {
  game: string;
  started_game_min: number;
  cargo: string;
  cargo_id: string;
  cargo_mass_kg: number;
  city_src: string;
  city_src_id: string;
  comp_src: string;
  comp_src_id: string;
  city_dst: string;
  city_dst_id: string;
  comp_dst: string;
  comp_dst_id: string;
  job_market: string;
  special_job: boolean;
  unit_count: number;
  unit_mass_kg: number;
  planned_distance_km: number;
  income: number;
  truck_id: string;
  truck_name: string;
  truck_brand: string;
  truck_plate: string;
}

export interface WireJobDelivered {
  finished_game_min: number;
  delivered_distance_km: number;
  delivery_time_min: number;
  cargo_damage: number;
  revenue: number;
  xp: number;
  autopark: boolean;
  autoload: boolean;
}

export interface WireJobCancelled {
  penalty: number;
}

export interface WireGameEvent {
  kind: string;
  game_min: number;
  amount: number;
  detail: string;
}

export type AgentMessage =
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "frame"; frame: WireFrame }
  | { type: "job-started"; job: WireJobStarted }
  | { type: "job-delivered"; job: WireJobDelivered }
  | { type: "job-cancelled"; job: WireJobCancelled }
  | { type: "game-event"; event: WireGameEvent };

const MS_TO_KMH = 3.6;

export function toWireFrame(frame: TelemetryFrame): WireFrame {
  return {
    t_ms: frame.t,
    game_min: frame.gameMin,
    speed_kmh: frame.speed * MS_TO_KMH,
    rpm: frame.rpm,
    gear: frame.gear,
    throttle: frame.throttle,
    brake: frame.brake,
    steer: frame.steer,
    clutch: frame.clutch,
    fuel_l: frame.fuel,
    adblue_l: frame.adblue,
    odometer_km: frame.odometerKm,
    cargo_damage: frame.cargoDamage,
    x: frame.x,
    y: frame.y,
    z: frame.z,
    heading_deg: frame.headingDeg,
    cruise_control: frame.cruiseControl,
    engine_on: frame.engineOn,
    park_brake: frame.parkBrake,
    game: frame.game,
    truck_id: frame.truckId,
    truck_name: frame.truckName,
    truck_brand: frame.truckBrand,
    truck_plate: frame.truckPlate,
  };
}

export function toWireJobStarted(
  job: JobInfo,
  frame: TelemetryFrame | null,
): WireJobStarted {
  return {
    game: frame?.game ?? "unknown",
    started_game_min: job.startingGameMin || frame?.gameMin || 0,
    cargo: job.cargo,
    cargo_id: job.cargoId,
    cargo_mass_kg: job.cargoMassKg,
    city_src: job.citySrc,
    city_src_id: job.citySrcId,
    comp_src: job.compSrc,
    comp_src_id: job.compSrcId,
    city_dst: job.cityDst,
    city_dst_id: job.cityDstId,
    comp_dst: job.compDst,
    comp_dst_id: job.compDstId,
    job_market: job.jobMarket,
    special_job: job.specialJob,
    unit_count: job.unitCount,
    unit_mass_kg: job.unitMassKg,
    planned_distance_km: job.plannedDistanceKm,
    income: job.income,
    truck_id: frame?.truckId ?? "",
    truck_name: frame?.truckName ?? "",
    truck_brand: frame?.truckBrand ?? "",
    truck_plate: frame?.truckPlate ?? "",
  };
}

export function toWireDelivered(job: DeliveredInfo): WireJobDelivered {
  return {
    finished_game_min: job.finishedGameMin,
    delivered_distance_km: job.distanceKm,
    delivery_time_min: job.deliveryTimeMin,
    cargo_damage: job.cargoDamage,
    revenue: job.revenue,
    xp: job.xp,
    autopark: job.autopark,
    autoload: job.autoload,
  };
}

export function toWireCancelled(job: CancelledInfo): WireJobCancelled {
  return { penalty: job.penalty };
}

export function toWireGameEvent(event: GameEventInput): WireGameEvent {
  return {
    kind: event.kind,
    game_min: event.gameMin,
    amount: Math.round(event.amount),
    detail: event.detail,
  };
}
