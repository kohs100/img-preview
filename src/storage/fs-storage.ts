import { access, mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import type { ObjectStorage } from "./types";

/**
 * Filesystem-backed object storage rooted at `baseDir`. Keys are POSIX
 * relative paths and are mapped onto the local path separator on the way in
 * and back to `/` on the way out, so keys stay portable across backends.
 */
export class FsStorage implements ObjectStorage {
  readonly backendName = "fs";

  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
  }

  private toPath(key: string): string {
    return path.join(this.baseDir, ...key.split("/"));
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.toPath(key));
  }

  async write(key: string, data: Buffer): Promise<void> {
    const filePath = this.toPath(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.toPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix = ""): Promise<string[]> {
    const all = await this.walk(this.baseDir);
    const keys = all.map((absPath) =>
      path.relative(this.baseDir, absPath).split(path.sep).join("/")
    );
    return prefix ? keys.filter((key) => key.startsWith(prefix)) : keys;
  }

  async delete(key: string): Promise<void> {
    await rm(this.toPath(key), { force: true });
  }

  private async walk(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          return this.walk(entryPath);
        }
        return [entryPath];
      })
    );
    return nested.flat();
  }
}
