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
   * by those that do not (the cache index keeps the content type).
   */
  write(
    key: string,
    data: Buffer,
    contentType?: string,
    onPhase?: (phase: "encrypting" | "uploading") => void
  ): Promise<void>;

  /** Resolve true if the key exists. */
  exists(key: string): Promise<boolean>;

  /** List every key, optionally restricted to those starting with `prefix`. */
  list(prefix?: string): Promise<string[]>;

  /** Delete an object. Resolves even if the key is already absent. */
  delete(key: string): Promise<void>;

  /**
   * Optional. Return a browser-reachable URL the client can be redirected to
   * (public object URL or presigned URL), so the app server can offload the
   * actual byte transfer. Backends that cannot serve objects directly (or are
   * not configured to) return `null`, in which case the server streams the
   * bytes itself.
   */
  getRedirectUrl?(key: string, endpointId?: string): Promise<string | null>;

  /**
   * Optional. The endpoints a client may pick for redirect URLs, or null when
   * there is no choice (no presigning, or only one distinct endpoint).
   */
  redirectEndpoints?(): RedirectEndpoints | null;
}

/**
 * Endpoints a presigned redirect URL can point at: the S3_BROWSER_ENDPOINT
 * entries (e.g. a CDN in front of the store). Unknown ids fall back to
 * `default`.
 */
export type RedirectEndpoints = {
  default: string;
  options: { id: string; label: string; url: string }[];
};

/** One S3_BROWSER_ENDPOINT entry: `url` or `name=url`. */
export type BrowserEndpoint = { name?: string; url: string };

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
  /**
   * Endpoints for browser-facing presigned URLs (S3_BROWSER_ENDPOINT), first
   * one as the default. Empty means presigned URLs use `endpoint`.
   */
  browserEndpoints: BrowserEndpoint[];
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Required by most non-AWS S3-compatible servers. */
  forcePathStyle: boolean;
  /** Optional key prefix so multiple deployments can share one bucket. */
  prefix: string;
  /**
   * Base URL (up to and including the bucket for path-style) used to build
   * public object URLs for redirect serving, e.g. `https://cdn.example.com` or
   * `http://localhost:9000/img-cache`. When set, cached images are served as a
   * 302 redirect instead of being streamed by the app server.
   */
  publicUrlBase?: string;
  /** When true, redirect to a presigned GET URL instead of a public URL. */
  presign: boolean;
  /** Presigned URL lifetime in seconds. */
  presignExpires: number;
};

export type BackendConfig = FsBackendConfig | S3BackendConfig;
