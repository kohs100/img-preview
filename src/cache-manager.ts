import { access, mkdir, readdir, readFile, writeFile } from "fs/promises";
import path from "path";

export type CacheEntry = {
  status: "processing" | "ready" | "error";
  filePath?: string;
  contentType?: string;
  errorStatusCode?: number;
  errorMessage?: string;
  updatedAt: number;
};

type PersistedCacheMeta = {
  url: string;
  filePathRelative: string;
  contentType: string;
  updatedAt: number;
};

const cacheMetaSuffix = ".meta.json";

export class CacheManager {
  private readonly cacheDir: string;

  private readonly processedDir: string;

  private readonly cache = new Map<string, CacheEntry>();

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    this.processedDir = path.join(cacheDir, "processed");
  }

  get(url: string): CacheEntry | undefined {
    return this.cache.get(url);
  }

  setProcessing(url: string): void {
    this.cache.set(url, { status: "processing", updatedAt: Date.now() });
  }

  async setReady(url: string, filePath: string, contentType: string): Promise<void> {
    await this.persistCacheMeta(url, filePath, contentType);
    this.cache.set(url, {
      status: "ready",
      filePath,
      contentType,
      updatedAt: Date.now(),
    });
  }

  setError(url: string, errorStatusCode: number, errorMessage: string): void {
    this.cache.set(url, {
      status: "error",
      errorStatusCode,
      errorMessage,
      updatedAt: Date.now(),
    });
  }

  async rebuildFromDisk(): Promise<void> {
    await mkdir(this.processedDir, { recursive: true });
    const allFiles = await this.listFilesRecursively(this.processedDir);
    const metaFiles = allFiles.filter((filePath) => filePath.endsWith(cacheMetaSuffix));

    for (const metaFile of metaFiles) {
      try {
        const raw = JSON.parse(await readFile(metaFile, "utf-8")) as unknown;
        if (!this.isPersistedMeta(raw)) {
          continue;
        }
        const filePath = path.resolve(this.cacheDir, raw.filePathRelative);
        await access(filePath);
        this.cache.set(raw.url, {
          status: "ready",
          filePath,
          contentType: raw.contentType,
          updatedAt: raw.updatedAt,
        });
      } catch {
        // Ignore malformed metadata entries and continue startup.
      }
    }
  }

  private getCacheMetaPath(filePath: string): string {
    return `${filePath}${cacheMetaSuffix}`;
  }

  private async persistCacheMeta(
    url: string,
    filePath: string,
    contentType: string
  ): Promise<void> {
    const filePathRelative = path.relative(this.cacheDir, filePath);
    const metadata: PersistedCacheMeta = {
      url,
      filePathRelative,
      contentType,
      updatedAt: Date.now(),
    };
    const metaPath = this.getCacheMetaPath(filePath);
    await writeFile(metaPath, `${JSON.stringify(metadata)}\n`);
  }

  private async listFilesRecursively(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          return this.listFilesRecursively(entryPath);
        }
        return [entryPath];
      })
    );
    return nested.flat();
  }

  private isPersistedMeta(raw: unknown): raw is PersistedCacheMeta {
    if (!raw || typeof raw !== "object") return false;
    const candidate = raw as Record<string, unknown>;
    return (
      typeof candidate.url === "string" &&
      typeof candidate.filePathRelative === "string" &&
      typeof candidate.contentType === "string" &&
      typeof candidate.updatedAt === "number"
    );
  }
}
