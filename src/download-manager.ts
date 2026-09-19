import sharp from "sharp";
import type { ObjectStorage } from "./storage";

export type ProcessingPhase =
  | "queued"
  | "downloading"
  | "transforming"
  | "encrypting"
  | "uploading"
  | "indexing";

export type ProcessingProgress = {
  phase: ProcessingPhase;
  completedBytes?: number;
  totalBytes?: number;
};

export class UpstreamHttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Fetches images from origin (rate-limited per host), optionally transcodes
 * PNG to WebP, and writes the result through an {@link ObjectStorage} backend.
 * Returns the storage key + content type of the servable object.
 */
export class DownloadManager {
  private readonly storage: ObjectStorage;

  private readonly originMinIntervalMs: number;

  private readonly originQueue = new Map<string, Promise<void>>();

  private readonly originNextAllowedAt = new Map<string, number>();

  constructor(storage: ObjectStorage, originMinIntervalMs: number) {
    this.storage = storage;
    this.originMinIntervalMs = originMinIntervalMs;
  }

  async downloadAndProcess(
    url: string,
    referrer: string,
    onProgress: (progress: ProcessingProgress) => void = () => undefined
  ): Promise<{ key: string; contentType: string }> {
    onProgress({ phase: "queued" });
    await this.throttleOriginRequest(url);
    const res = await fetch(url, { referrer });
    if (!res.ok) {
      throw new UpstreamHttpError(res.status, `Upstream fetch failed: ${res.status}`);
    }

    const totalHeader = Number(res.headers.get("content-length"));
    const totalBytes =
      Number.isFinite(totalHeader) && totalHeader >= 0 ? totalHeader : undefined;
    const inputBuffer = await this.readResponseBody(res, totalBytes, onProgress);
    const headerType = res.headers.get("content-type") || "";
    const sourceExt = this.extensionFromUrl(url) || this.extensionFromContentType(headerType);
    const isPng = headerType.includes("image/png") || url.toLowerCase().endsWith(".png");
    const processedExt = isPng ? ".webp" : sourceExt || ".bin";
    const { sourceKey, processedKey } = this.buildCacheKeys(url, sourceExt, processedExt);

    const sourceContentType = headerType || "application/octet-stream";
    await this.storage.write(
      sourceKey,
      inputBuffer,
      sourceContentType,
      (phase) => onProgress({ phase })
    );

    if (!isPng) {
      return { key: sourceKey, contentType: sourceContentType };
    }

    onProgress({ phase: "transforming" });
    const outputBuffer = await sharp(inputBuffer).webp({ quality: 80 }).toBuffer();
    await this.storage.write(
      processedKey,
      outputBuffer,
      "image/webp",
      (phase) => onProgress({ phase })
    );
    return { key: processedKey, contentType: "image/webp" };
  }

  private async readResponseBody(
    res: Response,
    totalBytes: number | undefined,
    onProgress: (progress: ProcessingProgress) => void
  ): Promise<Buffer> {
    onProgress({ phase: "downloading", completedBytes: 0, totalBytes });
    if (!res.body) {
      const data = Buffer.from(await res.arrayBuffer());
      onProgress({
        phase: "downloading",
        completedBytes: data.length,
        totalBytes,
      });
      return data;
    }

    const chunks: Buffer[] = [];
    const reader = res.body.getReader();
    let completedBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      completedBytes += chunk.length;
      onProgress({ phase: "downloading", completedBytes, totalBytes });
    }
    return Buffer.concat(chunks, completedBytes);
  }

  private async throttleOriginRequest(url: string): Promise<void> {
    if (!Number.isFinite(this.originMinIntervalMs) || this.originMinIntervalMs <= 0) {
      return;
    }

    const host = new URL(url).host;
    const previous = this.originQueue.get(host) || Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.originQueue.set(host, previous.then(() => current));

    await previous;
    try {
      const now = Date.now();
      const nextAllowedAt = this.originNextAllowedAt.get(host) || 0;
      const waitMs = Math.max(0, nextAllowedAt - now);
      if (waitMs > 0) {
        await this.sleep(waitMs);
      }
      this.originNextAllowedAt.set(host, Date.now() + this.originMinIntervalMs);
    } finally {
      release();
      if (this.originQueue.get(host) === current) {
        this.originQueue.delete(host);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private extensionFromContentType(contentType: string): string {
    if (contentType.includes("image/png")) return ".png";
    if (contentType.includes("image/jpeg")) return ".jpg";
    if (contentType.includes("image/webp")) return ".webp";
    if (contentType.includes("image/gif")) return ".gif";
    if (contentType.includes("image/svg+xml")) return ".svg";
    return ".bin";
  }

  private extensionFromUrl(url: string): string {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".png")) return ".png";
    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return ".jpg";
    if (pathname.endsWith(".webp")) return ".webp";
    if (pathname.endsWith(".gif")) return ".gif";
    if (pathname.endsWith(".svg")) return ".svg";
    return "";
  }

  private sanitizePathSegment(segment: string): string {
    return segment.replace(/[<>:"\\|?*\x00-\x1f]/g, "_");
  }

  private splitPathname(pathnameValue: string): string[] {
    return pathnameValue
      .split("/")
      .filter(Boolean)
      .map((segment) => this.sanitizePathSegment(segment));
  }

  private buildCacheKeys(url: string, sourceExt: string, processedExt: string) {
    const parsed = new URL(url);
    const segments = this.splitPathname(parsed.pathname);
    const hostDir = this.sanitizePathSegment(parsed.hostname);

    const hasDirectoryPath = parsed.pathname.endsWith("/") || segments.length === 0;
    const sourceName = hasDirectoryPath
      ? `index${sourceExt}`
      : segments.pop() || `index${sourceExt}`;

    const sourceKey = ["source", hostDir, ...segments, sourceName].join("/");

    const processedBase = hasDirectoryPath
      ? `index${processedExt}`
      : `${this.stripExt(sourceName)}${processedExt}`;
    const processedKey = ["processed", hostDir, ...segments, processedBase].join("/");

    return { sourceKey, processedKey };
  }

  private stripExt(filename: string): string {
    const dotIndex = filename.lastIndexOf(".");
    return dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  }
}
