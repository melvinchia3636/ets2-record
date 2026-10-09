export type Game = "ets2" | "ats" | "unknown";

export type TripStatus = "active" | "delivered" | "cancelled" | "interrupted";

export interface TelemetryFrame {
  t: number;
  gameMin: number;
  speed: number;
  rpm: number;
  gear: number;
  throttle: number;
  brake: number;
  steer: number;
  clutch: number;
  fuel: number;
  adblue: number;
  odometerKm: number;
  cargoDamage: number;
  engineOn: boolean;
  parkBrake: boolean;
  cruiseControl: boolean;
  lightsBeamLow: boolean;
  routeDistanceM: number;
  routeTimeS: number;
  restStopMin: number;
  x: number;
  y: number;
  z: number;
  headingDeg: number;
  game: Game;
  truckId: string;
  truckName: string;
  truckBrand: string;
  truckPlate: string;
  onJob: boolean;
}

export interface JobInfo {
  cargo: string;
  cargoId: string;
  cargoMassKg: number;
  citySrc: string;
  citySrcId: string;
  compSrc: string;
  compSrcId: string;
  cityDst: string;
  cityDstId: string;
  compDst: string;
  compDstId: string;
  jobMarket: string;
  specialJob: boolean;
  unitCount: number;
  unitMassKg: number;
  plannedDistanceKm: number;
  income: number;
  startingGameMin: number;
  deliveryWindowGameMin: number;
}

export interface DeliveredInfo extends JobInfo {
  finishedGameMin: number;
  deliveryTimeMin: number;
  distanceKm: number;
  cargoDamage: number;
  revenue: number;
  xp: number;
  autopark: boolean;
  autoload: boolean;
}

export interface CancelledInfo extends JobInfo {
  penalty: number;
}

export type GameEventKind = "fine" | "refuel" | "tollgate" | "ferry" | "train";

export interface GameEventInput {
  kind: GameEventKind;
  gameMin: number;
  amount: number;
  detail: string;
}

export interface SampleRow {
  tripId: number;
  tMs: number;
  gameMin: number;
  speedKmh: number;
  rpm: number;
  gear: number;
  throttle: number;
  brake: number;
  steer: number;
  clutch: number;
  fuelL: number;
  adblueL: number;
  odometerKm: number;
  cargoDamage: number;
  x: number;
  y: number;
  z: number;
  headingDeg: number;
  cruiseControl: boolean;
  engineOn: boolean;
  parkBrake: boolean;
}
