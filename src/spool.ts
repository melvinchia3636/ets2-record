import { promises as fs } from "node:fs";
import path from "node:path";
import type { ScreenshotMeta } from "./types.js";

export interface SpoolEntry {
  id: string;
  meta: ScreenshotMeta;
  imagePath: string;
}

/**
 * A durable on-disk queue of screenshots waiting to be uploaded. Each entry is
 * an image plus a JSON sidecar; entries survive restarts so a screenshot taken
 * while the recorder is unreachable is never lost.
 */
export class ScreenshotSpool {
  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async add(sourcePath: string, meta: ScreenshotMeta): Promise<void> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const imagePath = path.join(this.dir, `${id}${path.extname(meta.filename)}`);
    await fs.copyFile(sourcePath, imagePath);
    await fs.writeFile(
      path.join(this.dir, `${id}.json`),
      JSON.stringify(meta),
      "utf8",
    );
  }

  /** Pending entries, oldest first. */
  async list(): Promise<SpoolEntry[]> {
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    const entries: SpoolEntry[] = [];

    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      const raw = await fs
        .readFile(path.join(this.dir, name), "utf8")
        .catch(() => null);
      if (!raw) continue;
      let meta: ScreenshotMeta;
      try {
        meta = JSON.parse(raw) as ScreenshotMeta;
      } catch {
        continue;
      }
      const imageName = names.find(
        (candidate) => candidate.startsWith(`${id}.`) && !candidate.endsWith(".json"),
      );
      if (!imageName) continue;
      entries.push({ id, meta, imagePath: path.join(this.dir, imageName) });
    }

    entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return entries;
  }

  async remove(entry: SpoolEntry): Promise<void> {
    await fs.unlink(entry.imagePath).catch(() => {});
    await fs.unlink(path.join(this.dir, `${entry.id}.json`)).catch(() => {});
  }
}
