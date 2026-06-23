import path from "path";
import { FsStorage } from "./fs-storage";
import { S3Storage } from "./s3-storage";
import type { BackendConfig, ObjectStorage } from "./types";

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * Build a backend config from environment variables.
 *
 * `CACHE_BACKEND` selects `fs` (default) or `s3`. Filesystem uses `CACHE_DIR`
 * (default `./cache`). S3 uses the `S3_*` variables.
 */
export function backendConfigFromEnv(
  kindOverride?: "fs" | "s3"
): BackendConfig {
  const kind =
    kindOverride ?? (process.env.CACHE_BACKEND === "s3" ? "s3" : "fs");

  if (kind === "fs") {
    return {
      kind: "fs",
      baseDir: path.resolve(process.env.CACHE_DIR || "cache"),
    };
  }

  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error("S3_BUCKET is required when using the s3 backend");
  }
  return {
    kind: "s3",
    bucket,
    region: process.env.S3_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT || undefined,
    accessKeyId: process.env.S3_ACCESS_KEY_ID || undefined,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || undefined,
    forcePathStyle: envBool(process.env.S3_FORCE_PATH_STYLE, true),
    prefix: process.env.S3_PREFIX || "",
  };
}

export function createStorage(config: BackendConfig): ObjectStorage {
  if (config.kind === "fs") {
    return new FsStorage(config.baseDir);
  }
  return new S3Storage(config);
}

/** Convenience: build the storage backend selected by the environment. */
export function createStorageFromEnv(kindOverride?: "fs" | "s3"): ObjectStorage {
  return createStorage(backendConfigFromEnv(kindOverride));
}
