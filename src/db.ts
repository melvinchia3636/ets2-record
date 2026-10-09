import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CancelledInfo,
  DeliveredInfo,
  GameEventInput,
  JobInfo,
  SampleRow,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'job',
  session_id INTEGER REFERENCES trips(id) ON DELETE SET NULL,
  game TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'active',
  started_at_ms INTEGER NOT NULL,
  started_game_min REAL,
  finished_at_ms INTEGER,
  finished_game_min REAL,
  cargo TEXT, cargo_id TEXT, cargo_mass_kg REAL,
  city_src TEXT, city_src_id TEXT, comp_src TEXT, comp_src_id TEXT,
  city_dst TEXT, city_dst_id TEXT, comp_dst TEXT, comp_dst_id TEXT,
  job_market TEXT, special_job INTEGER NOT NULL DEFAULT 0,
  unit_count INTEGER, unit_mass_kg REAL,
  planned_distance_km REAL, delivered_distance_km REAL, distance_km REAL,
  revenue INTEGER, income INTEGER, penalty INTEGER, xp INTEGER,
  cargo_damage REAL, autopark INTEGER NOT NULL DEFAULT 0, autoload INTEGER NOT NULL DEFAULT 0,
  delivery_time_min REAL,
  avg_speed_kmh REAL, max_speed_kmh REAL, fuel_used_l REAL, adblue_used_l REAL, idle_min REAL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  truck_id TEXT, truck_name TEXT, truck_brand TEXT, truck_plate TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  t_ms INTEGER NOT NULL,
  game_min REAL NOT NULL,
  speed_kmh REAL NOT NULL,
  rpm REAL NOT NULL,
  gear INTEGER NOT NULL,
  throttle REAL NOT NULL, brake REAL NOT NULL, steer REAL NOT NULL, clutch REAL NOT NULL,
  fuel_l REAL NOT NULL, adblue_l REAL NOT NULL, odometer_km REAL NOT NULL,
  cargo_damage REAL NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
  heading_deg REAL NOT NULL,
  cruise_control INTEGER NOT NULL, engine_on INTEGER NOT NULL, park_brake INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_samples_trip ON samples(trip_id, t_ms);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER REFERENCES trips(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  game_min REAL NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '',
  created_at_ms INTEGER NOT NULL
);
`;

type Anchor = {
  t: number;
  game: string;
  truckId: string;
  truckName: string;
  truckBrand: string;
  truckPlate: string;
};

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.ensureColumns();
  }

  private ensureColumns(): void {
    const cols = this.db.prepare("PRAGMA table_info(trips)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("kind")) {
      this.db.exec("ALTER TABLE trips ADD COLUMN kind TEXT NOT NULL DEFAULT 'job'");
    }
    if (!names.has("session_id")) {
      this.db.exec("ALTER TABLE trips ADD COLUMN session_id INTEGER");
    }
  }

  markStaleActiveTrips(maxAgeMs = 10 * 60 * 1000, excludeIds: number[] = []): number {
    const now = Date.now();
    const params: Record<string, number> = { now, cutoff: now - maxAgeMs };
    let exclude = "";
    excludeIds.forEach((id, i) => {
      params[`ex${i}`] = id;
      exclude += `@ex${i},`;
    });
    if (exclude) exclude = ` AND id NOT IN (${exclude.slice(0, -1)})`;
    const info = this.db
      .prepare(
        `UPDATE trips SET status = 'interrupted', finished_at_ms = COALESCE(finished_at_ms, @now)
         WHERE status = 'active'${exclude}
           AND COALESCE((SELECT MAX(t_ms) FROM samples WHERE trip_id = trips.id), started_at_ms) < @cutoff`,
      )
      .run(params);
    return info.changes;
  }

  createSession(firstFrame: Anchor): number {
    const info = this.db
      .prepare(
        `INSERT INTO trips (kind, game, status, started_at_ms, truck_id, truck_name, truck_brand, truck_plate, created_at_ms)
         VALUES ('session', @game, 'active', @startedAtMs, @truckId, @truckName, @truckBrand, @truckPlate, @createdAtMs)`,
      )
      .run({
        game: firstFrame.game,
        startedAtMs: firstFrame.t,
        truckId: firstFrame.truckId || null,
        truckName: firstFrame.truckName || null,
        truckBrand: firstFrame.truckBrand || null,
        truckPlate: firstFrame.truckPlate || null,
        createdAtMs: Date.now(),
      });
    return Number(info.lastInsertRowid);
  }

  finishSession(sessionId: number, finishedGameMin: number | null): void {
    this.db
      .prepare(
        "UPDATE trips SET status='completed', finished_at_ms=@now, finished_game_min=@gameMin WHERE id=@id AND status='active'",
      )
      .run({ id: sessionId, now: Date.now(), gameMin: finishedGameMin });
    this.recomputeStats(sessionId);
  }

  interruptTrip(id: number): void {
    this.db
      .prepare("UPDATE trips SET status='interrupted', finished_at_ms=? WHERE id=? AND status='active'")
      .run(Date.now(), id);
    this.recomputeStats(id);
  }

  createTrip(job: JobInfo, firstFrame: Anchor, sessionId: number | null = null): number {
    const info = this.db
      .prepare(
        `INSERT INTO trips (
          kind, session_id, game, status, started_at_ms, started_game_min,
          cargo, cargo_id, cargo_mass_kg,
          city_src, city_src_id, comp_src, comp_src_id,
          city_dst, city_dst_id, comp_dst, comp_dst_id,
          job_market, special_job, unit_count, unit_mass_kg,
          planned_distance_km, income, delivery_time_min,
          truck_id, truck_name, truck_brand, truck_plate, created_at_ms
        ) VALUES (
          'job', @sessionId, @game, 'active', @startedAtMs, @startedGameMin,
          @cargo, @cargoId, @cargoMassKg,
          @citySrc, @citySrcId, @compSrc, @compSrcId,
          @cityDst, @cityDstId, @compDst, @compDstId,
          @jobMarket, @specialJob, @unitCount, @unitMassKg,
          @plannedDistanceKm, @income, @deliveryTimeMin,
          @truckId, @truckName, @truckBrand, @truckPlate, @createdAtMs
        )`,
      )
      .run({
        sessionId,
        game: firstFrame.game,
        startedAtMs: firstFrame.t,
        startedGameMin: job.startingGameMin,
        cargo: job.cargo,
        cargoId: job.cargoId,
        cargoMassKg: job.cargoMassKg,
        citySrc: job.citySrc,
        citySrcId: job.citySrcId,
        compSrc: job.compSrc,
        compSrcId: job.compSrcId,
        cityDst: job.cityDst,
        cityDstId: job.cityDstId,
        compDst: job.compDst,
        compDstId: job.compDstId,
        jobMarket: job.jobMarket,
        specialJob: job.specialJob ? 1 : 0,
        unitCount: job.unitCount,
        unitMassKg: job.unitMassKg,
        plannedDistanceKm: job.plannedDistanceKm,
        income: job.income,
        deliveryTimeMin: null,
        truckId: firstFrame.truckId || null,
        truckName: firstFrame.truckName || null,
        truckBrand: firstFrame.truckBrand || null,
        truckPlate: firstFrame.truckPlate || null,
        createdAtMs: Date.now(),
      });
    return Number(info.lastInsertRowid);
  }

  updateTripMeta(tripId: number, frame: Anchor): void {
    this.db
      .prepare(
        `UPDATE trips SET
           game = CASE WHEN game = 'unknown' THEN @game ELSE game END,
           truck_id = @truckId, truck_name = @truckName, truck_brand = @truckBrand, truck_plate = @truckPlate
         WHERE id = @id AND (truck_id IS NULL OR truck_id = '')`,
      )
      .run({ id: tripId, ...frame });
  }

  insertSamples(rows: SampleRow[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO samples (
        trip_id, t_ms, game_min, speed_kmh, rpm, gear, throttle, brake, steer, clutch,
        fuel_l, adblue_l, odometer_km, cargo_damage, x, y, z, heading_deg,
        cruise_control, engine_on, park_brake
      ) VALUES (
        @tripId, @tMs, @gameMin, @speedKmh, @rpm, @gear, @throttle, @brake, @steer, @clutch,
        @fuelL, @adblueL, @odometerKm, @cargoDamage, @x, @y, @z, @headingDeg,
        @cruiseControl, @engineOn, @parkBrake
      )`,
    );
    const tx = this.db.transaction((batch: SampleRow[]) => {
      for (const row of batch) {
        stmt.run({
          ...row,
          cruiseControl: row.cruiseControl ? 1 : 0,
          engineOn: row.engineOn ? 1 : 0,
          parkBrake: row.parkBrake ? 1 : 0,
        });
      }
    });
    tx(rows);
  }

  insertEvent(tripId: number | null, event: GameEventInput): void {
    this.db
      .prepare(
        "INSERT INTO events (trip_id, kind, game_min, amount, detail, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(tripId, event.kind, event.gameMin, Math.round(event.amount), event.detail, Date.now());
  }

  finalizeDelivered(tripId: number, d: DeliveredInfo): void {
    this.db
      .prepare(
        `UPDATE trips SET status='delivered', finished_at_ms=@finishedAtMs, finished_game_min=@finishedGameMin,
          delivered_distance_km=@distanceKm, revenue=@revenue, xp=@xp, cargo_damage=@cargoDamage,
          autopark=@autopark, autoload=@autoload, delivery_time_min=@deliveryTimeMin
         WHERE id=@id`,
      )
      .run({
        id: tripId,
        finishedAtMs: Date.now(),
        finishedGameMin: d.finishedGameMin,
        distanceKm: d.distanceKm,
        revenue: d.revenue,
        xp: d.xp,
        cargoDamage: d.cargoDamage,
        autopark: d.autopark ? 1 : 0,
        autoload: d.autoload ? 1 : 0,
        deliveryTimeMin: d.deliveryTimeMin,
      });
    this.recomputeStats(tripId);
  }

  finalizeCancelled(tripId: number, c: CancelledInfo): void {
    this.db
      .prepare("UPDATE trips SET status='cancelled', finished_at_ms=?, penalty=? WHERE id=?")
      .run(Date.now(), c.penalty, tripId);
    this.recomputeStats(tripId);
  }

  recomputeStats(tripId: number): void {
    const trip = this.db
      .prepare("SELECT kind, session_id, started_at_ms, finished_at_ms FROM trips WHERE id = ?")
      .get(tripId) as
      | { kind: string; session_id: number | null; started_at_ms: number; finished_at_ms: number | null }
      | undefined;
    if (!trip) return;

    const samples =
      trip.kind === "job" && trip.session_id !== null
        ? (this.db
            .prepare("SELECT speed_kmh, odometer_km, fuel_l, adblue_l, engine_on, t_ms FROM samples WHERE trip_id = ? AND t_ms >= ? AND t_ms <= ? ORDER BY t_ms")
            .all(trip.session_id, trip.started_at_ms, trip.finished_at_ms ?? Number.MAX_SAFE_INTEGER))
        : this.db
            .prepare("SELECT speed_kmh, odometer_km, fuel_l, adblue_l, engine_on, t_ms FROM samples WHERE trip_id = ? ORDER BY t_ms")
            .all(tripId);

    const rows = samples as Array<{
      speed_kmh: number;
      odometer_km: number;
      fuel_l: number;
      adblue_l: number;
      engine_on: number;
      t_ms: number;
    }>;

    if (rows.length === 0) {
      this.db.prepare("UPDATE trips SET sample_count=0 WHERE id=?").run(tripId);
      return;
    }

    let maxSpeed = 0;
    let minOdo = rows[0].odometer_km;
    let maxOdo = rows[0].odometer_km;
    let fuelUsed = 0;
    let adblueUsed = 0;
    let idleMs = 0;
    let prev = rows[0];

    for (const s of rows) {
      maxSpeed = Math.max(maxSpeed, s.speed_kmh);
      minOdo = Math.min(minOdo, s.odometer_km);
      maxOdo = Math.max(maxOdo, s.odometer_km);
      fuelUsed += Math.max(0, prev.fuel_l - s.fuel_l);
      adblueUsed += Math.max(0, prev.adblue_l - s.adblue_l);
      const dt = Math.min(s.t_ms - prev.t_ms, 5000);
      if (prev.engine_on === 1 && prev.speed_kmh < 1) idleMs += Math.max(0, dt);
      prev = s;
    }

    const distance = Math.max(0, maxOdo - minOdo);
    const row = this.db.prepare("SELECT delivery_time_min FROM trips WHERE id=?").get(tripId) as
      | { delivery_time_min: number | null }
      | undefined;
    const driveMin = row?.delivery_time_min ?? null;
    const avgSpeed = driveMin && driveMin > 0 ? distance / (driveMin / 60) : null;

    this.db
      .prepare(
        `UPDATE trips SET sample_count=@count, distance_km=@distance, max_speed_kmh=@maxSpeed,
          avg_speed_kmh=@avgSpeed, fuel_used_l=@fuelUsed, adblue_used_l=@adblueUsed, idle_min=@idleMin
         WHERE id=@id`,
      )
      .run({
        id: tripId,
        count: rows.length,
        distance: Math.round(distance * 100) / 100,
        maxSpeed: Math.round(maxSpeed * 10) / 10,
        avgSpeed: avgSpeed === null ? null : Math.round(avgSpeed * 10) / 10,
        fuelUsed: Math.round(fuelUsed * 100) / 100,
        adblueUsed: Math.round(adblueUsed * 1000) / 1000,
        idleMin: Math.round((idleMs / 60000) * 100) / 100,
      });
  }

  close(): void {
    this.db.close();
  }
}
