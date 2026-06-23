import sharp from "sharp";
import type { ObjectStorage } from "./storage";

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
    referrer: string
  ): Promise<{ key: string; contentType: string }> {
    await this.throttleOriginRequest(url);
    const res = await fetch(url, { referrer });
    if (!res.ok) {
      throw new UpstreamHttpError(res.status, `Upstream fetch failed: ${res.status}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);
    const headerType = res.headers.get("content-type") || "";
    const sourceExt = this.extensionFromUrl(url) || this.extensionFromContentType(headerType);
    const isPng = headerType.includes("image/png") || url.toLowerCase().endsWith(".png");
    const processedExt = isPng ? ".webp" : sourceExt || ".bin";
    const { sourceKey, processedKey } = this.buildCacheKeys(url, sourceExt, processedExt);

    const sourceContentType = headerType || "application/octet-stream";
    await this.storage.write(sourceKey, inputBuffer, sourceContentType);

    if (!isPng) {
      return { key: sourceKey, contentType: sourceContentType };
    }

    const outputBuffer = await sharp(inputBuffer).webp({ quality: 80 }).toBuffer();
    await this.storage.write(processedKey, outputBuffer, "image/webp");
    return { key: processedKey, contentType: "image/webp" };
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
