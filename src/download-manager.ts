import sharp from "sharp";
import { createHash } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

export class UpstreamHttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class DownloadManager {
  private readonly sourceDir: string;

  private readonly processedDir: string;

  private readonly originMinIntervalMs: number;

  private readonly originQueue = new Map<string, Promise<void>>();

  private readonly originNextAllowedAt = new Map<string, number>();

  constructor(cacheDir: string, originMinIntervalMs: number) {
    this.sourceDir = path.join(cacheDir, "source");
    this.processedDir = path.join(cacheDir, "processed");
    this.originMinIntervalMs = originMinIntervalMs;
  }

  async downloadAndProcess(url: string, referrer: string): Promise<{ filePath: string; contentType: string }> {
    await mkdir(this.sourceDir, { recursive: true });

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
    const { sourcePath, processedPath } = this.buildCachePaths(url, sourceExt, processedExt);

    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, inputBuffer);

    if (!isPng) {
      return {
        filePath: sourcePath,
        contentType: headerType || "application/octet-stream",
      };
    }

    await mkdir(this.processedDir, { recursive: true });
    await mkdir(path.dirname(processedPath), { recursive: true });
    const outputBuffer = await sharp(inputBuffer).webp({ quality: 80 }).toBuffer();
    await writeFile(processedPath, outputBuffer);
    return { filePath: processedPath, contentType: "image/webp" };
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

  // private makeQuerySuffix(search: string): string {
  //   if (!search) return "";
  //   const shortHash = createHash("sha1").update(search).digest("hex").slice(0, 8);
  //   return `__q_${shortHash}`;
  // }

  // private withSuffixBeforeExt(filename: string, suffix: string): string {
  //   if (!suffix) return filename;
  //   const ext = path.extname(filename);
  //   if (!ext) return `${filename}${suffix}`;
  //   const base = filename.slice(0, -ext.length);
  //   return `${base}${suffix}${ext}`;
  // }

  private buildCachePaths(url: string, sourceExt: string, processedExt: string) {
    const parsed = new URL(url);
    const segments = this.splitPathname(parsed.pathname);
    const hostDir = this.sanitizePathSegment(parsed.hostname);
    // const querySuffix = this.makeQuerySuffix(parsed.search);

    const hasDirectoryPath = parsed.pathname.endsWith("/") || segments.length === 0;
    const sourceName = hasDirectoryPath
      ? `index${sourceExt}`
      : segments.pop() || `index${sourceExt}`;
    // const sourceFile = this.withSuffixBeforeExt(sourceName, querySuffix);
    const sourceFile = sourceName;
    const sourceRelative = path.join(hostDir, ...segments, sourceFile);
    const sourcePath = path.join(this.sourceDir, sourceRelative);

    const processedBase = hasDirectoryPath
      ? `index${processedExt}`
      : `${path.parse(sourceName).name}${processedExt}`;
    // const processedFile = this.withSuffixBeforeExt(processedBase, querySuffix);
    const processedFile = processedBase;
    const processedRelative = path.join(hostDir, ...segments, processedFile);
    const processedPath = path.join(this.processedDir, processedRelative);

    return { sourcePath, processedPath };
  }
}
