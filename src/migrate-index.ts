import { cacheIndexKey, type PersistedCacheMeta } from "./cache-manager";
import {
  backendConfigFromEnv,
  createStorage,
  EncryptedStorage,
} from "./storage";

function isMeta(value: unknown): value is PersistedCacheMeta {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.url === "string" &&
    (typeof item.key === "string" ||
      typeof item.filePathRelative === "string") &&
    typeof item.contentType === "string" &&
    typeof item.updatedAt === "number"
  );
}

async function main(): Promise<void> {
  const storage = createStorage(backendConfigFromEnv());
  if (!(storage instanceof EncryptedStorage)) {
    throw new Error("migrate-index requires CACHE_ENCRYPTION=true");
  }
  await storage.ensureReady();

  const allKeys = await storage.list();
  const legacyKeys = allKeys.filter((key) => key.endsWith(".meta.json"));
  const indexEntries = new Map<string, Buffer>();
  let nextRead = 0;
  await Promise.all(
    Array.from({ length: 32 }, async () => {
      for (;;) {
        const index = nextRead;
        nextRead += 1;
        if (index >= legacyKeys.length) return;
        try {
          const data = await storage.read(legacyKeys[index]);
          const parsed = JSON.parse(data.toString("utf8")) as unknown;
          if (isMeta(parsed)) indexEntries.set(cacheIndexKey(parsed.url), data);
        } catch {
          // Keep converting other valid legacy entries.
        }
      }
    })
  );

  const existing = new Set(await storage.list("index/"));
  const entries = [...indexEntries].filter(([key]) => !existing.has(key));
  let completed = 0;
  for (let offset = 0; offset < entries.length; offset += 32) {
    const batch = entries.slice(offset, offset + 32);
    await Promise.all(
      batch.map(async ([key, data]) => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await storage.write(key, data, "application/json");
            return;
          } catch (error) {
            lastError = error;
            if (attempt < 3) {
              await new Promise((resolve) =>
                setTimeout(resolve, attempt * 500)
              );
            }
          }
        }
        throw lastError;
      })
    );
    completed += batch.length;
    if (completed % 1024 === 0 || completed === entries.length) {
      // eslint-disable-next-line no-console
      console.log(`index progress ${completed}/${entries.length}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `Index migration complete: legacy=${legacyKeys.length} unique=${indexEntries.size}` +
      ` copied=${entries.length} skipped=${indexEntries.size - entries.length}`
  );
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
