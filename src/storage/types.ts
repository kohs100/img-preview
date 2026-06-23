/**
 * Backend-agnostic object storage used by the image cache.
 *
 * A "key" is always a POSIX-style relative path (forward slashes, no leading
 * slash), e.g. `processed/cdn.example.com/char/1.webp`. The same key set is
 * used regardless of whether objects live on the local filesystem or in an
 * S3-compatible bucket, which is what makes migration between backends a
 * straight copy of keys.
 */
export interface ObjectStorage {
  /** Human-readable backend name, used in logs (e.g. `fs`, `s3`). */
  readonly backendName: string;

  /** Read the full object body. Rejects if the key does not exist. */
  read(key: string): Promise<Buffer>;

  /**
   * Write an object, creating any intermediate structure as needed.
   * `contentType` is persisted by backends that support it (S3) and ignored
   * by those that do not (filesystem keeps content type in the meta sidecar).
   */
  write(key: string, data: Buffer, contentType?: string): Promise<void>;

  /** Resolve true if the key exists. */
  exists(key: string): Promise<boolean>;

  /** List every key, optionally restricted to those starting with `prefix`. */
  list(prefix?: string): Promise<string[]>;

  /** Delete an object. Resolves even if the key is already absent. */
  delete(key: string): Promise<void>;
}

export type FsBackendConfig = {
  kind: "fs";
  baseDir: string;
};

export type S3BackendConfig = {
  kind: "s3";
  bucket: string;
  region: string;
  /** Custom endpoint for S3-compatible services (MinIO, R2, etc.). */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Required by most non-AWS S3-compatible servers. */
  forcePathStyle: boolean;
  /** Optional key prefix so multiple deployments can share one bucket. */
  prefix: string;
};

export type BackendConfig = FsBackendConfig | S3BackendConfig;
