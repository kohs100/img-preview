import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorage, S3BackendConfig } from "./types";

/**
 * S3-compatible object storage. Works with AWS S3 as well as MinIO,
 * Cloudflare R2, Backblaze B2, etc. via a custom `endpoint` + path-style
 * addressing. An optional key `prefix` is transparently prepended to every
 * key, so the rest of the app only ever deals with bare cache keys.
 */
export class S3Storage implements ObjectStorage {
  readonly backendName = "s3";

  private readonly client: S3Client;

  private readonly bucket: string;

  private readonly prefix: string;

  private readonly publicUrlBase?: string;

  private readonly presign: boolean;

  private readonly presignExpires: number;

  constructor(config: S3BackendConfig) {
    this.bucket = config.bucket;
    this.prefix = config.prefix ? config.prefix.replace(/\/+$/, "") + "/" : "";
    this.publicUrlBase = config.publicUrlBase?.replace(/\/+$/, "");
    this.presign = config.presign;
    this.presignExpires = config.presignExpires;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials:
        config.accessKeyId && config.secretAccessKey
          ? {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            }
          : undefined,
    });
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

  async write(key: string, data: Buffer, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.toObjectKey(key),
        Body: data,
        ContentType: contentType,
      })
    );
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

  async getRedirectUrl(key: string): Promise<string | null> {
    const objectKey = this.toObjectKey(key);
    if (this.publicUrlBase && !this.presign) {
      const encodedPath = objectKey
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      return `${this.publicUrlBase}/${encodedPath}`;
    }
    if (this.presign) {
      return getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
        { expiresIn: this.presignExpires }
      );
    }
    return null;
  }
}
