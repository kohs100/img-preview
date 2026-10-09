import express from "express";
import net from "net";
import { type CacheEntry, CacheManager } from "./cache-manager";
import { DownloadManager, UpstreamHttpError } from "./download-manager";
import { egressPoolFromEnv } from "./egress-pool";
import { backendConfigFromEnv, createStorage, EncryptedStorage } from "./storage";

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3013;
const originMinIntervalMs = process.env.ORIGIN_MIN_INTERVAL_MS
  ? Number(process.env.ORIGIN_MIN_INTERVAL_MS)
  : 200;
// How long a cached origin error is honored before the next request retries it.
const errorRetryMs = process.env.ERROR_RETRY_MS
  ? Number(process.env.ERROR_RETRY_MS)
  : 5 * 60 * 1000;
const originMaxConcurrency = process.env.ORIGIN_MAX_CONCURRENCY
  ? Number(process.env.ORIGIN_MAX_CONCURRENCY)
  : 8;
const originRetries = process.env.ORIGIN_RETRIES
  ? Number(process.env.ORIGIN_RETRIES)
  : 2;
// Node tries each resolved address for only 250ms by default ("happy
// eyeballs"); under a burst of new connections that gives up before a single
// SYN retransmit and surfaces as AggregateError [ETIMEDOUT].
net.setDefaultAutoSelectFamilyAttemptTimeout(
  process.env.ORIGIN_CONNECT_ATTEMPT_TIMEOUT_MS
    ? Number(process.env.ORIGIN_CONNECT_ATTEMPT_TIMEOUT_MS)
    : 2000
);
const backendConfig = backendConfigFromEnv();
const storage = createStorage(backendConfig);
const cacheManager = new CacheManager(storage);
// Limits apply per egress route (direct and each proxy); 0 means effectively
// unlimited, as before.
const egressPool = egressPoolFromEnv({
  defaultConcurrency: originMaxConcurrency > 0 ? originMaxConcurrency : 1000,
  minIntervalMs: originMinIntervalMs,
});
const proxyCheckIntervalMs = process.env.PROXY_CHECK_INTERVAL_MS
  ? Number(process.env.PROXY_CHECK_INTERVAL_MS)
  : 10 * 60 * 1000;
const downloadManager = new DownloadManager(storage, egressPool, originRetries);

app.get("/", (_req, res) => {
  res.redirect("/static");
});

app.use("/static", express.static("public"));

/** Endpoints the frontend may choose for presigned image URLs. */
app.get("/api/storage/endpoints", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const endpoints = storage.redirectEndpoints?.() ?? null;
  res.json({
    selectable: endpoints !== null,
    default: "browser",
    options: endpoints
      ? (["browser", "direct"] as const).map((id) => ({
          id,
          origin: new URL(endpoints[id]).origin,
        }))
      : [],
  });
});

app.get("/api/proxies", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(egressPool.snapshot());
});

/** Re-reads proxy.json, checks every route (or `ids`) and returns the state. */
app.post("/api/proxies/check", express.json({ limit: "16kb" }), async (req, res) => {
  const ids = (req.body as { ids?: unknown } | undefined)?.ids;
  const checkIds =
    Array.isArray(ids) && ids.every((id) => typeof id === "string")
      ? (ids as string[])
      : undefined;
  if (!checkIds) egressPool.loadConfig();
  await egressPool.check(checkIds);
  res.setHeader("Cache-Control", "no-store");
  res.json(egressPool.snapshot());
});

app.patch("/api/proxies/:id", express.json({ limit: "16kb" }), async (req, res) => {
  const body = (req.body ?? {}) as { enabled?: unknown; concurrency?: unknown };
  const patch: { enabled?: boolean; concurrency?: number } = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }
    patch.enabled = body.enabled;
  }
  if (body.concurrency !== undefined) {
    if (!Number.isInteger(body.concurrency) || (body.concurrency as number) < 1) {
      res.status(400).json({ error: "concurrency must be an integer >= 1" });
      return;
    }
    patch.concurrency = body.concurrency as number;
  }
  try {
    if (!(await egressPool.updateSettings(req.params.id, patch))) {
      res.status(404).json({ error: "Unknown route" });
      return;
    }
  } catch (error) {
    res.status(500).json({
      error: `Could not save settings: ${error instanceof Error ? error.message : error}`,
    });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(egressPool.snapshot());
});

app.post("/api/submissions", express.json({ limit: "64kb" }), (req, res) => {
  const timestamp = new Date().toISOString();
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  // eslint-disable-next-line no-console
  console.log(
    `[${timestamp}] frontend-submission ${JSON.stringify(payload)}`
  );
  res.status(204).end();
});

app.get("/api/encryption/config", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!(storage instanceof EncryptedStorage)) {
    res.json({ enabled: false });
    return;
  }
  try {
    res.json({ enabled: true, envelope: await storage.getMasterKeyEnvelope() });
  } catch {
    res.status(503).json({ error: "Encryption key is unavailable" });
  }
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

/** Stack plus the `cause` chain, e.g. undici's "fetch failed" -> ECONNREFUSED. */
function describeError(error: unknown): string {
  const lines: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && depth < 5; depth += 1) {
    const prefix = depth === 0 ? "" : "Caused by: ";
    if (current instanceof Error) {
      lines.push(prefix + (current.stack ?? `${current.name}: ${current.message}`));
      current = (current as { cause?: unknown }).cause;
    } else {
      lines.push(prefix + String(current));
      break;
    }
  }
  return lines.join("\n");
}

function startDownload(cacheKey: string, fetchUrl: string, referrer: string): void {
  cacheManager.setProcessing(cacheKey);
  downloadManager
    .downloadAndProcess(fetchUrl, referrer, (progress) => {
      cacheManager.updateProgress(cacheKey, progress);
    })
    .then(({ key, contentType }) => {
      cacheManager.updateProgress(cacheKey, { phase: "indexing" });
      return cacheManager.setReady(cacheKey, key, contentType);
    })
    .catch((error: unknown) => {
      const errorStatusCode =
        error instanceof UpstreamHttpError ? error.statusCode : 502;
      const errorMessage =
        error instanceof Error ? error.message : "Upstream fetch failed";
      if (errorStatusCode === 502) {
        // eslint-disable-next-line no-console
        console.error(
          `[${new Date().toISOString()}] cache-fill-failed 502 ${fetchUrl} ` +
            `referrer=${referrer}\n${describeError(error)}`
        );
      }
      cacheManager.setError(cacheKey, errorStatusCode, errorMessage);
    });
}

function processingPayload(entry?: CacheEntry) {
  const completedBytes = entry?.completedBytes;
  const totalBytes = entry?.totalBytes;
  const percent =
    completedBytes !== undefined && totalBytes !== undefined && totalBytes > 0
      ? Math.min(100, Math.round((completedBytes / totalBytes) * 100))
      : undefined;
  return {
    status: "processing" as const,
    phase: entry?.phase ?? "queued",
    completedBytes,
    totalBytes,
    percent,
  };
}

function errorPayload(entry: CacheEntry) {
  return {
    status: "error" as const,
    phase: "failed" as const,
    errorStatusCode: entry.errorStatusCode ?? 502,
    message: entry.errorMessage || "Upstream fetch failed",
  };
}

function sendProcessing(res: express.Response, entry?: CacheEntry): void {
  res.setHeader("Retry-After", "1");
  res.status(503).json(processingPayload(entry));
}

/**
 * Starts a cache fill for a URL that is not cached yet or whose cached error
 * is older than ERROR_RETRY_MS, and returns the entry to report. Ready
 * entries, running fills and fresh errors are returned unchanged.
 */
function ensureFill(
  cacheKey: string,
  fetchUrl: string,
  referrer: string,
  entry: CacheEntry | undefined
): CacheEntry | undefined {
  if (entry?.status === "ready" || entry?.status === "processing") return entry;
  if (entry?.status === "error") {
    const errorAgeMs = Date.now() - entry.updatedAt;
    if (!(errorRetryMs > 0 && errorAgeMs >= errorRetryMs)) return entry;
    // Cached error is stale; retry the origin instead of serving it again.
    startDownload(cacheKey, fetchUrl, referrer);
  } else if (cacheManager.claimProcessing(cacheKey)) {
    startDownload(cacheKey, fetchUrl, referrer);
  }
  return cacheManager.getCached(cacheKey);
}

function resolveImage(
  rawPath: string,
  referrerQuery: string
): { cacheKey: string; fetchUrl: string; referrer: string } {
  const fetchUrl = normalizeUrl(rawPath);
  const cacheKey = toCacheKey(fetchUrl);
  const referrer = referrerQuery ? normalizeUrl(referrerQuery) : "https://babechat.ai";
  return { cacheKey, fetchUrl, referrer };
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
  return resolveImage(rawPath, firstQueryValue(req.query.referrer));
}

app.get("/cached/:imageUrl(*)", async (req, res) => {
  const params = resolveRequestParams(req);
  if (!params) {
    res.status(400).send("Missing image path");
    return;
  }

  const { cacheKey, fetchUrl, referrer } = params;
  const entry =
    (await cacheManager.get(cacheKey)) ?? cacheManager.getCached(cacheKey);

  if (entry?.status === "ready" && entry.key && entry.contentType) {
    // Offload the byte transfer to the storage backend when it can hand out a
    // browser-reachable URL (public/presigned). A failure to build that URL
    // must never break serving, so it degrades to streaming the bytes instead.
    let redirectUrl: string | null = null;
    if (storage.getRedirectUrl) {
      try {
        redirectUrl = await storage.getRedirectUrl(
          entry.key,
          firstQueryValue(req.query.endpoint) === "direct" ? "direct" : "browser"
        );
      } catch {
        redirectUrl = null;
      }
    }
    if (redirectUrl) {
      if (storage instanceof EncryptedStorage) {
        res.setHeader("Cache-Control", "no-store");
        res.json({
          encrypted: true,
          url: redirectUrl,
          contentType: entry.contentType,
        });
        return;
      }
      res.redirect(302, redirectUrl);
      return;
    }

    try {
      if (storage instanceof EncryptedStorage) {
        const encrypted = await storage.readEncrypted(entry.key);
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("X-Image-Content-Type", entry.contentType);
        res.status(200).send(encrypted);
        return;
      }
      const fileBuffer = await storage.read(entry.key);
      res.setHeader("Content-Type", entry.contentType);
      res.status(200).send(fileBuffer);
    } catch {
      // Object vanished from the backend; re-fetch from origin.
      startDownload(cacheKey, fetchUrl, referrer);
      sendProcessing(res, cacheManager.getCached(cacheKey));
    }
    return;
  }

  // Start processing (or keep waiting) and return 503 until done
  const current = ensureFill(cacheKey, fetchUrl, referrer, entry);
  if (current?.status === "error") {
    res.status(current.errorStatusCode ?? 502).json(errorPayload(current));
    return;
  }
  sendProcessing(res, current);
});

const CACHE_STATUS_MAX_URLS = 500;

/**
 * Batch status for the download page: starts fills for uncached URLs and
 * reports each URL's state without transferring image bytes. URLs use the
 * same form as the /cached path (scheme optional, query/hash ignored).
 */
app.post(
  "/api/cache-status",
  express.json({ limit: "1mb" }),
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const body = (req.body ?? {}) as { urls?: unknown; referrer?: unknown };
    const urls = body.urls;
    if (
      !Array.isArray(urls) ||
      urls.length === 0 ||
      urls.length > CACHE_STATUS_MAX_URLS ||
      !urls.every((url) => typeof url === "string" && url.length > 0)
    ) {
      res.status(400).json({
        error: `urls must be 1..${CACHE_STATUS_MAX_URLS} non-empty strings`,
      });
      return;
    }
    const referrerQuery = typeof body.referrer === "string" ? body.referrer : "";

    const results = new Array<unknown>(urls.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(32, urls.length) }, async () => {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= urls.length) return;
          try {
            // Mirror /cached: the browser drops ?query/#hash from the path
            // and Express percent-decodes the route parameter.
            const rawPath = decodeURIComponent(
              (urls[index] as string).split(/[?#]/)[0]
            );
            const { cacheKey, fetchUrl, referrer } = resolveImage(
              rawPath,
              referrerQuery
            );
            const entry =
              (await cacheManager.get(cacheKey)) ?? cacheManager.getCached(cacheKey);
            const current = ensureFill(cacheKey, fetchUrl, referrer, entry);
            if (current?.status === "ready") {
              results[index] = { status: "ready", phase: "ready" };
            } else if (current?.status === "error") {
              results[index] = errorPayload(current);
            } else {
              results[index] = processingPayload(current);
            }
          } catch {
            results[index] = {
              status: "error",
              phase: "failed",
              errorStatusCode: 400,
              message: "Invalid image URL",
            };
          }
        }
      })
    );
    res.json({ results });
  }
);

app.get("/refresh/:imageUrl(*)", (req, res) => {
  const params = resolveRequestParams(req);
  if (!params) {
    res.status(400).send("Missing image path");
    return;
  }

  const { cacheKey, fetchUrl, referrer } = params;
  startDownload(cacheKey, fetchUrl, referrer);
  sendProcessing(res, cacheManager.getCached(cacheKey));
});

async function startServer(): Promise<void> {
  // Unlike an ordinary index-listing failure, a bad encryption passphrase
  // must fail closed instead of starting a server that can never serve data.
  if (storage instanceof EncryptedStorage) await storage.ensureReady();
  // Proxies join the pool as their checks pass; direct is usable meanwhile.
  void egressPool.check();
  if (proxyCheckIntervalMs > 0) {
    setInterval(() => void egressPool.check(), proxyCheckIntervalMs).unref();
  }
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `Server running on http://localhost:${port} (cache backend: ${storage.backendName})`
    );
  });
}

void startServer().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

