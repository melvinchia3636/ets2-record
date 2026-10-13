import { existsSync, promises as fs, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** A screenshot file that has finished being written by the game. */
export interface CapturedScreenshot {
  path: string;
  filename: string;
  capturedAt: number;
  size: number;
  mime: string;
}

const IMAGE_EXT = /\.(png|jpe?g)$/i;
/** The game embeds a real-world timestamp, e.g. `ets2_20250303_190127_00.png`. */
const NAME_TIMESTAMP = /(\d{8})_(\d{6})/;

/** How often the folders are re-scanned to catch events `fs.watch` misses. */
const SCAN_MS = 3000;
/** The game writes the PNG over a moment, so wait for the size to settle. */
const SETTLE_MS = 250;
const SETTLE_TRIES = 40;

export function mimeFor(filename: string): string {
  return /\.jpe?g$/i.test(filename) ? "image/jpeg" : "image/png";
}

/** Lists image files across the given folders (missing folders are skipped). */
export async function listScreenshotFiles(dirs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const dir of dirs) {
    try {
      for (const name of await fs.readdir(dir)) {
        if (IMAGE_EXT.test(name)) files.push(path.join(dir, name));
      }
    } catch {
      // ignore missing/unreadable folders
    }
  }
  return files;
}

/** Parses the real-world capture time from the filename, falling back to mtime. */
export function parseCapturedAt(filename: string, fallback: number): number {
  const match = NAME_TIMESTAMP.exec(filename);
  if (!match) return fallback;
  const date = match[1]!;
  const time = match[2]!;
  const parsed = new Date(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
    Number(time.slice(0, 2)),
    Number(time.slice(2, 4)),
    Number(time.slice(4, 6)),
  );
  const t = parsed.getTime();
  return Number.isNaN(t) ? fallback : t;
}

/** Best-effort default screenshot folders for the current OS, filtered to ones that exist. */
export function defaultScreenshotDirs(): string[] {
  const home = homedir();
  const ets2 = "Euro Truck Simulator 2";
  const ats = "American Truck Simulator";
  const candidates: string[] = [];

  if (process.platform === "win32") {
    const docs = path.join(home, "Documents");
    candidates.push(
      path.join(docs, ets2, "screenshot"),
      path.join(docs, ats, "screenshot"),
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      path.join(home, "Documents", ets2, "screenshot"),
      path.join(home, "Documents", ats, "screenshot"),
      path.join(home, "Library", "Application Support", ets2, "screenshot"),
      path.join(home, "Library", "Application Support", ats, "screenshot"),
    );
  } else {
    candidates.push(
      path.join(home, ".local", "share", ets2, "screenshot"),
      path.join(home, ".local", "share", ats, "screenshot"),
      path.join(home, ".var", "app", "com.valvesoftware.Steam", "data", ets2, "screenshot"),
      path.join(home, ".var", "app", "com.valvesoftware.Steam", "data", ats, "screenshot"),
      path.join(
        home,
        ".local",
        "share",
        "Steam",
        "steamapps",
        "compatdata",
        "227300",
        "pfx",
        "drive_c",
        "users",
        "steamuser",
        "Documents",
        ets2,
        "screenshot",
      ),
      path.join(
        home,
        ".local",
        "share",
        "Steam",
        "steamapps",
        "compatdata",
        "270880",
        "pfx",
        "drive_c",
        "users",
        "steamuser",
        "Documents",
        ats,
        "screenshot",
      ),
    );
  }

  return candidates.filter((dir) => existsSync(dir));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Watches one or more screenshot folders and emits an event once a newly
 * written image has settled. Files already present at startup are ignored, and
 * `fs.watch` is backed by a periodic scan because it drops events.
 */
export class ScreenshotWatcher {
  private readonly watchers: FSWatcher[] = [];
  private readonly seen = new Set<string>();
  private readonly listeners = new Set<(shot: CapturedScreenshot) => void>();
  private scanTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly dirs: string[],
    private readonly log: (message: string) => void = () => {},
  ) {}

  on(listener: (shot: CapturedScreenshot) => void): this {
    this.listeners.add(listener);
    return this;
  }

  async start(options: { baseline?: Iterable<string> } = {}): Promise<void> {
    if (options.baseline) {
      for (const file of options.baseline) this.seen.add(file);
    } else {
      for (const dir of this.dirs) {
        await this.baseline(dir);
      }
    }

    for (const dir of this.dirs) {
      try {
        const watcher = watch(dir, () => void this.scan(dir));
        watcher.on("error", () => {});
        this.watchers.push(watcher);
      } catch (err) {
        this.log(`screenshots: cannot watch ${dir} (${(err as Error).message})`);
      }
    }
    this.scanTimer = setInterval(() => {
      for (const dir of this.dirs) void this.scan(dir);
    }, SCAN_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers.length = 0;
  }

  private async baseline(dir: string): Promise<void> {
    for (const name of await this.list(dir)) {
      this.seen.add(path.join(dir, name));
    }
  }

  private async list(dir: string): Promise<string[]> {
    try {
      return (await fs.readdir(dir)).filter((name) => IMAGE_EXT.test(name));
    } catch {
      return [];
    }
  }

  private async scan(dir: string): Promise<void> {
    if (this.stopped) return;
    for (const name of await this.list(dir)) {
      const full = path.join(dir, name);
      if (this.seen.has(full)) continue;
      this.seen.add(full);
      void this.process(full);
    }
  }

  private async process(full: string): Promise<void> {
    const stable = await this.waitForStable(full);
    if (!stable) return;
    const filename = path.basename(full);
    for (const listener of this.listeners) {
      listener({
        path: full,
        filename,
        capturedAt: parseCapturedAt(filename, stable.mtimeMs),
        size: stable.size,
        mime: mimeFor(filename),
      });
    }
  }

  private async waitForStable(
    full: string,
  ): Promise<{ size: number; mtimeMs: number } | null> {
    let last = -1;
    for (let i = 0; i < SETTLE_TRIES; i++) {
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        return null;
      }
      if (stat.size > 0 && stat.size === last) {
        return { size: stat.size, mtimeMs: stat.mtimeMs };
      }
      last = stat.size;
      await sleep(SETTLE_MS);
    }
    return last > 0 ? { size: last, mtimeMs: Date.now() } : null;
  }
}
