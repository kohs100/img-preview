import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorage, RedirectEndpoints, S3BackendConfig } from "./types";

type PresignTarget = { id: string; label: string; url: string; client: S3Client };

function sameUrl(a: string, b: string): boolean {
  return new URL(a).href === new URL(b).href;
}

/**
 * S3-compatible object storage. Works with AWS S3 as well as MinIO,
 * Cloudflare R2, Backblaze B2, etc. via a custom `endpoint` + path-style
 * addressing. An optional key `prefix` is transparently prepended to every
 * key, so the rest of the app only ever deals with bare cache keys.
 */
export class S3Storage implements ObjectStorage {
  readonly backendName = "s3";

  private readonly client: S3Client;

  /** Clients for presigned URLs; the first one is the default. */
  private readonly presignTargets: PresignTarget[];

  private readonly bucket: string;

  private readonly prefix: string;

  private readonly publicUrlBase?: string;

  private readonly presign: boolean;

  private readonly presignExpires: number;

  private readonly requestTimeoutMs: number;

  constructor(config: S3BackendConfig) {
    this.bucket = config.bucket;
    this.prefix = config.prefix ? config.prefix.replace(/\/+$/, "") + "/" : "";
    this.publicUrlBase = config.publicUrlBase?.replace(/\/+$/, "");
    this.presign = config.presign;
    this.presignExpires = config.presignExpires;
    this.requestTimeoutMs =
      Number(process.env.S3_REQUEST_TIMEOUT_MS || "60000") || 60_000;
    const clientOptions = {
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials:
        config.accessKeyId && config.secretAccessKey
          ? {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            }
          : undefined,
    };
    this.client = new S3Client({
      ...clientOptions,
      endpoint: config.endpoint,
    });
    // Browser endpoints first (unnamed ones are browser, browser2, ...), then
    // S3_ENDPOINT as `direct` unless a browser entry already points there.
    const browser = config.browserEndpoints;
    this.presignTargets = browser.map((entry, index) => ({
      id: entry.name ?? (index === 0 ? "browser" : `browser${index + 1}`),
      label: entry.name ?? (browser.length > 1 ? `Browser ${index + 1}` : "Browser"),
      url: entry.url,
      client:
        config.endpoint && sameUrl(entry.url, config.endpoint)
          ? this.client
          : new S3Client({ ...clientOptions, endpoint: entry.url }),
    }));
    if (
      this.presignTargets.length === 0 ||
      (config.endpoint && !browser.some((entry) => sameUrl(entry.url, config.endpoint!)))
    ) {
      this.presignTargets.push({
        id: "direct",
        label: "Direct",
        url: config.endpoint ?? "",
        client: this.client,
      });
    }
    const ids = this.presignTargets.map((target) => target.id);
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate) {
      throw new Error(`S3_BROWSER_ENDPOINT has a duplicate endpoint id: ${duplicate}`);
    }
  }

  private toObjectKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  async read(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.toObjectKey(key) })
    );
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) {
      throw new Error(`Empty body for key: ${key}`);
    }
    return Buffer.from(bytes);
  }

  async write(
    key: string,
    data: Buffer,
    contentType?: string,
    onPhase?: (phase: "encrypting" | "uploading") => void
  ): Promise<void> {
    onPhase?.("uploading");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.toObjectKey(key),
          Body: data,
          ContentType: contentType,
        }),
        { abortSignal: controller.signal }
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.toObjectKey(key),
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix = ""): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.toObjectKey(prefix),
          ContinuationToken: continuationToken,
        })
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key) {
          keys.push(obj.Key.slice(this.prefix.length));
        }
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.toObjectKey(key),
      })
    );
  }

  redirectEndpoints(): RedirectEndpoints | null {
    if (!this.presign || this.presignTargets.length < 2) return null;
    return {
      default: this.presignTargets[0].id,
      options: this.presignTargets.map(({ id, label, url }) => ({ id, label, url })),
    };
  }

  async getRedirectUrl(key: string, endpointId?: string): Promise<string | null> {
    const objectKey = this.toObjectKey(key);
    if (this.publicUrlBase && !this.presign) {
      const encodedPath = objectKey
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      return `${this.publicUrlBase}/${encodedPath}`;
    }
    if (this.presign) {
      const target =
        this.presignTargets.find((item) => item.id === endpointId) ??
        this.presignTargets[0];
      return getSignedUrl(
        target.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
        { expiresIn: this.presignExpires }
      );
    }
    return null;
  }
}
