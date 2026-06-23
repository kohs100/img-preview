import express from "express";
import { CacheManager } from "./cache-manager";
import { DownloadManager, UpstreamHttpError } from "./download-manager";
import { backendConfigFromEnv, createStorage } from "./storage";

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3013;
const originMinIntervalMs = process.env.ORIGIN_MIN_INTERVAL_MS
  ? Number(process.env.ORIGIN_MIN_INTERVAL_MS)
  : 200;
// How long a cached origin error is honored before the next request retries it.
const errorRetryMs = process.env.ERROR_RETRY_MS
  ? Number(process.env.ERROR_RETRY_MS)
  : 5 * 60 * 1000;
const backendConfig = backendConfigFromEnv();
const storage = createStorage(backendConfig);
const cacheManager = new CacheManager(storage);
const downloadManager = new DownloadManager(storage, originMinIntervalMs);

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
    .then(({ key, contentType }) => {
      return cacheManager.setReady(cacheKey, key, contentType);
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

  if (entry?.status === "ready" && entry.key && entry.contentType) {
    // Offload the byte transfer to the storage backend when it can hand out a
    // browser-reachable URL (public/presigned). A failure to build that URL
    // must never break serving, so it degrades to streaming the bytes instead.
    let redirectUrl: string | null = null;
    if (storage.getRedirectUrl) {
      try {
        redirectUrl = await storage.getRedirectUrl(entry.key);
      } catch {
        redirectUrl = null;
      }
    }
    if (redirectUrl) {
      res.redirect(302, redirectUrl);
      return;
    }

    try {
      const fileBuffer = await storage.read(entry.key);
      res.setHeader("Content-Type", entry.contentType);
      res.status(200).send(fileBuffer);
    } catch {
      // Object vanished from the backend; re-fetch from origin.
      startDownload(cacheKey, fetchUrl, referrer);
      res.status(503).send("Processing");
    }
    return;
  }

  if (entry?.status === "processing") {
    res.status(503).send("Processing");
    return;
  }

  if (entry?.status === "error") {
    const errorAgeMs = Date.now() - entry.updatedAt;
    if (errorRetryMs > 0 && errorAgeMs >= errorRetryMs) {
      // Cached error is stale; retry the origin instead of serving it again.
      startDownload(cacheKey, fetchUrl, referrer);
      res.status(503).send("Processing");
      return;
    }
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

void cacheManager.rebuildFromStorage().finally(() => {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `Server running on http://localhost:${port} (cache backend: ${storage.backendName})`
    );
  });
});
