import { createHash } from "crypto";
import type { ProcessingProgress } from "./download-manager";
import type { ObjectStorage } from "./storage";

export type CacheEntry = {
  status: "processing" | "ready" | "error";
  key?: string;
  contentType?: string;
  errorStatusCode?: number;
  errorMessage?: string;
  updatedAt: number;
  phase?: ProcessingProgress["phase"];
  completedBytes?: number;
  totalBytes?: number;
};

export type PersistedCacheMeta = {
  url: string;
  key?: string;
  filePathRelative?: string;
  contentType: string;
  updatedAt: number;
};

/** Deterministic lookup key; EncryptedStorage maps it to a secret HMAC path. */
export function cacheIndexKey(url: string): string {
  const digest = createHash("sha256").update(url).digest("base64url");
  return `index/${digest}.json`;
}

/** In-memory hot cache backed by one deterministic storage object per URL. */
export class CacheManager {
  private readonly cache = new Map<string, CacheEntry>();

  private readonly pendingLoads = new Map<
    string,
    Promise<CacheEntry | undefined>
  >();

  constructor(private readonly storage: ObjectStorage) {}

  getCached(url: string): CacheEntry | undefined {
    return this.cache.get(url);
  }

  async get(url: string): Promise<CacheEntry | undefined> {
    const cached = this.cache.get(url);
    if (cached) return cached;

    const pending = this.pendingLoads.get(url);
    if (pending) return pending;

    const load = this.loadPersisted(url).finally(() => {
      this.pendingLoads.delete(url);
    });
    this.pendingLoads.set(url, load);
    return load;
  }

  setProcessing(url: string): void {
    this.cache.set(url, {
      status: "processing",
      phase: "queued",
      updatedAt: Date.now(),
    });
  }

  updateProgress(url: string, progress: ProcessingProgress): void {
    const current = this.cache.get(url);
    if (current?.status !== "processing") return;
    this.cache.set(url, {
      status: "processing",
      ...progress,
      updatedAt: Date.now(),
    });
  }

  claimProcessing(url: string): boolean {
    if (this.cache.has(url)) return false;
    this.setProcessing(url);
    return true;
  }

  async setReady(url: string, key: string, contentType: string): Promise<void> {
    const updatedAt = Date.now();
    const metadata: PersistedCacheMeta = { url, key, contentType, updatedAt };
    await this.storage.write(
      cacheIndexKey(url),
      Buffer.from(`${JSON.stringify(metadata)}\n`),
      "application/json"
    );
    this.cache.set(url, { status: "ready", key, contentType, updatedAt });
  }

  setError(url: string, errorStatusCode: number, errorMessage: string): void {
    this.cache.set(url, {
      status: "error",
      errorStatusCode,
      errorMessage,
      updatedAt: Date.now(),
    });
  }

  private async loadPersisted(url: string): Promise<CacheEntry | undefined> {
    try {
      const raw = JSON.parse(
        (await this.storage.read(cacheIndexKey(url))).toString("utf8")
      ) as unknown;
      if (!this.isPersistedMeta(raw) || raw.url !== url) return undefined;
      const key = raw.key ?? raw.filePathRelative;
      if (!key) return undefined;
      const entry: CacheEntry = {
        status: "ready",
        key,
        contentType: raw.contentType,
        updatedAt: raw.updatedAt,
      };
      this.cache.set(url, entry);
      return entry;
    } catch {
      // Missing index objects are normal cache misses. Corrupt/authentication
      // failures also fail closed and are healed by fetching the origin again.
      return undefined;
    }
  }

  private isPersistedMeta(raw: unknown): raw is PersistedCacheMeta {
    if (!raw || typeof raw !== "object") return false;
    const value = raw as Record<string, unknown>;
    return (
      typeof value.url === "string" &&
      (typeof value.key === "string" ||
        typeof value.filePathRelative === "string") &&
      typeof value.contentType === "string" &&
      typeof value.updatedAt === "number"
    );
  }
}
