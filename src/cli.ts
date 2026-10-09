#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { Store } from "./db.js";
import { Recorder } from "./recorder.js";
import { TelemetryAgent, WebSocketServerProvider } from "./remote.js";
import { LiveProvider } from "./telemetry.js";

function resolveDb(explicit?: string): string {
  return explicit ?? process.env.ETS2_RECORD_DB ?? resolve(process.cwd(), "ets2-record.db");
}

const program = new Command();
program
  .name("ets2-record")
  .description("Record ETS2/ATS telemetry: a recorder server + a remote telemetry agent")
  .version("0.1.0");

program
  .command("serve")
  .description("run a recording server that accepts telemetry from remote agents")
  .option("--db <path>", "database path")
  .option("--host <host>", "bind address", "0.0.0.0")
  .option("--port <n>", "listening port", "8787")
  .option("--token <token>", "shared secret required from agents")
  .option("--interval <ms>", "sample interval in ms", "500")
  .option("--flush <ms>", "database flush interval in ms", "2000")
  .option("--stale-minutes <n>", "age before a stuck active trip is marked interrupted", "10")
  .action((opts) => {
    const db = resolveDb(opts.db);
    const store = new Store(db);
    const stale = store.markStaleActiveTrips(Number(opts.staleMinutes) * 60 * 1000);
    if (stale > 0) console.log(`marked ${stale} stale active trip(s) as interrupted`);
    const provider = new WebSocketServerProvider({
      host: opts.host,
      port: Number(opts.port),
      token: opts.token,
      log: (m) => console.log(`[serve] ${m}`),
      onClient: (id, ip) => console.log(`[serve] agent '${id}' from ${ip}`),
    });
    const recorder = new Recorder(store, provider, {
      intervalMs: Number(opts.interval),
      flushMs: Number(opts.flush),
      staleMs: Number(opts.staleMinutes) * 60 * 1000,
      log: (m) => console.log(`[serve] ${m}`),
    });
    const auth = opts.token ? " (token required)" : "";
    console.log(`recording remote telemetry -> ${db}${auth}`);
    const shutdown = () => {
      recorder.stop();
      store.close();
      console.log("\nstopped.");
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    recorder.start();
  });

program
  .command("agent")
  .description("stream local game telemetry to a remote recorder server")
  .requiredOption("--server <url>", "recorder server WebSocket URL, e.g. ws://host:8787")
  .option("--token <token>", "shared secret")
  .option("--interval <ms>", "frame send interval in ms", "500")
  .option("--shared-memory <name>", "shared memory name (macOS/Linux default /SCSTelemetry)")
  .action((opts) => {
    const agent = new TelemetryAgent(new LiveProvider(opts.sharedMemory), {
      server: opts.server,
      token: opts.token,
      intervalMs: Number(opts.interval),
      log: (m) => console.log(`[agent] ${m}`),
    });
    console.log(`streaming to ${opts.server} (Ctrl+C to stop)`);
    console.log("start a job in-game to record");
    const shutdown = () => {
      agent.stop();
      console.log("\nstopped.");
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    agent.start();
  });

program.parse();
