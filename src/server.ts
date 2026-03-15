import express from "express";
import { readFile } from "fs/promises";
import path from "path";
import { CacheManager } from "./cache-manager";
import { DownloadManager, UpstreamHttpError } from "./download-manager";

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3013;
const cacheDir = path.resolve("cache");
const originMinIntervalMs = process.env.ORIGIN_MIN_INTERVAL_MS
  ? Number(process.env.ORIGIN_MIN_INTERVAL_MS)
  : 200;
const cacheManager = new CacheManager(cacheDir);
const downloadManager = new DownloadManager(cacheDir, originMinIntervalMs);

app.get("/", (_req, res) => {
  res.redirect("/static");
});

app.use("/static", express.static("public"));
app.use(express.json({ limit: "64kb" }));

app.post("/api/submissions", (req, res) => {
  const timestamp = new Date().toISOString();
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  // eslint-disable-next-line no-console
  console.log(
    `[${timestamp}] frontend-submission ${JSON.stringify(payload)}`
  );
  res.status(204).end();
});

function normalizeUrl(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function firstQueryValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

function toCacheKey(url: string): string {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function startDownload(cacheKey: string, fetchUrl: string, referrer: string): void {
  cacheManager.setProcessing(cacheKey);
  downloadManager
    .downloadAndProcess(fetchUrl, referrer)
    .then(({ filePath, contentType }) => {
      return cacheManager.setReady(cacheKey, filePath, contentType);
    })
    .catch((error: unknown) => {
      const errorStatusCode =
        error instanceof UpstreamHttpError ? error.statusCode : 502;
      const errorMessage =
        error instanceof Error ? error.message : "Upstream fetch failed";
      cacheManager.setError(cacheKey, errorStatusCode, errorMessage);
    });
}

function resolveRequestParams(req: express.Request): {
  cacheKey: string;
  fetchUrl: string;
  referrer: string;
} | null {
  const rawPath = req.params.imageUrl;
  if (!rawPath) {
    return null;
  }

  const fetchUrl = normalizeUrl(rawPath);
  const cacheKey = toCacheKey(fetchUrl);
  const referrerQuery = firstQueryValue(req.query.referrer);
  const referrer = referrerQuery ? normalizeUrl(referrerQuery) : "https://babechat.ai";

  return { cacheKey, fetchUrl, referrer };
}

app.get("/cached/:imageUrl(*)", async (req, res) => {
  const params = resolveRequestParams(req);
  if (!params) {
    res.status(400).send("Missing image path");
    return;
  }

  const { cacheKey, fetchUrl, referrer } = params;
  const entry = cacheManager.get(cacheKey);

  if (entry?.status === "ready" && entry.filePath && entry.contentType) {
    res.setHeader("Content-Type", entry.contentType);
    const fileBuffer = await readFile(entry.filePath);
    res.status(200).send(fileBuffer);
    return;
  }

  if (entry?.status === "processing") {
    res.status(503).send("Processing");
    return;
  }

  if (entry?.status === "error") {
    res.status(entry.errorStatusCode ?? 502).send(entry.errorMessage || "Upstream fetch failed");
    return;
  }

  // Start processing and return 503 until done
  startDownload(cacheKey, fetchUrl, referrer);
  res.status(503).send("Processing");
});

app.get("/refresh/:imageUrl(*)", (req, res) => {
  const params = resolveRequestParams(req);
  if (!params) {
    res.status(400).send("Missing image path");
    return;
  }

  const { cacheKey, fetchUrl, referrer } = params;
  startDownload(cacheKey, fetchUrl, referrer);
  res.status(503).send("Processing");
});

void cacheManager.rebuildFromDisk().finally(() => {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Server running on http://localhost:${port}`);
  });
});
