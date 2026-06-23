import type { ObjectStorage } from "./storage";

export type CacheEntry = {
  status: "processing" | "ready" | "error";
  /** Storage key of the servable object (backend-agnostic). */
  key?: string;
  contentType?: string;
  errorStatusCode?: number;
  errorMessage?: string;
  updatedAt: number;
};

type PersistedCacheMeta = {
  url: string;
  /** New field. Older meta files use `filePathRelative` instead. */
  key?: string;
  filePathRelative?: string;
  contentType: string;
  updatedAt: number;
};

const cacheMetaSuffix = ".meta.json";

/**
 * Tracks the state of each cached image keyed by its origin URL. The actual
 * bytes live in an {@link ObjectStorage} backend; this manager only holds the
 * lightweight in-memory index plus the persisted `.meta.json` sidecars that
 * let the index be rebuilt on startup.
 */
export class CacheManager {
  private readonly storage: ObjectStorage;

  private readonly cache = new Map<string, CacheEntry>();

  constructor(storage: ObjectStorage) {
    this.storage = storage;
  }

  get(url: string): CacheEntry | undefined {
    return this.cache.get(url);
  }

  setProcessing(url: string): void {
    this.cache.set(url, { status: "processing", updatedAt: Date.now() });
  }

  async setReady(url: string, key: string, contentType: string): Promise<void> {
    await this.persistCacheMeta(url, key, contentType);
    this.cache.set(url, {
      status: "ready",
      key,
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

  /** Rebuild the in-memory index from the `.meta.json` sidecars in storage. */
  async rebuildFromStorage(): Promise<void> {
    let allKeys: string[];
    try {
      allKeys = await this.storage.list();
    } catch (error) {
      // A listing failure (transient backend error, missing permission) must
      // not stop startup — the cache repopulates on demand. Log and continue.
      // eslint-disable-next-line no-console
      console.warn(
        `Cache index rebuild skipped: ${
          error instanceof Error ? error.message : error
        }`
      );
      return;
    }
    const metaKeys = allKeys.filter((key) => key.endsWith(cacheMetaSuffix));

    for (const metaKey of metaKeys) {
      try {
        const raw = JSON.parse(
          (await this.storage.read(metaKey)).toString("utf-8")
        ) as unknown;
        if (!this.isPersistedMeta(raw)) {
          continue;
        }
        const objectKey = raw.key ?? raw.filePathRelative;
        if (!objectKey || !(await this.storage.exists(objectKey))) {
          continue;
        }
        this.cache.set(raw.url, {
          status: "ready",
          key: objectKey,
          contentType: raw.contentType,
          updatedAt: raw.updatedAt,
        });
      } catch {
        // Ignore malformed metadata entries and continue startup.
      }
    }
  }

  private getCacheMetaKey(key: string): string {
    return `${key}${cacheMetaSuffix}`;
  }

  private async persistCacheMeta(
    url: string,
    key: string,
    contentType: string
  ): Promise<void> {
    const metadata: PersistedCacheMeta = {
      url,
      key,
      contentType,
      updatedAt: Date.now(),
    };
    await this.storage.write(
      this.getCacheMetaKey(key),
      Buffer.from(`${JSON.stringify(metadata)}\n`),
      "application/json"
    );
  }

  private isPersistedMeta(raw: unknown): raw is PersistedCacheMeta {
    if (!raw || typeof raw !== "object") return false;
    const candidate = raw as Record<string, unknown>;
    const hasObjectKey =
      typeof candidate.key === "string" ||
      typeof candidate.filePathRelative === "string";
    return (
      typeof candidate.url === "string" &&
      hasObjectKey &&
      typeof candidate.contentType === "string" &&
      typeof candidate.updatedAt === "number"
    );
  }
}
