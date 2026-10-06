import { backendConfigFromEnv, createStorage, S3Storage } from "./storage";
import {
  decryptObject,
  ENCRYPTED_PATH_PREFIX,
  MASTER_KEY_OBJECT,
  type MasterKeyEnvelope,
  PathCipher,
  unwrapMasterKey,
} from "./storage/crypto-format";
import {
  LEGACY_MANIFEST_OBJECT,
  LEGACY_OBJECT_PREFIX,
  legacyObjectKey,
  loadLegacyManifest,
} from "./storage/legacy-v1";
import type { ObjectStorage } from "./storage";

/**
 * Moves the v1 encrypted layout (HMAC names + manifest) to v2 EME paths.
 * Object bodies keep the same AES-GCM format, so each object is copied as-is
 * (server-side on S3). Re-running only copies what is still missing, and the
 * legacy objects are removed only with --delete-legacy.
 *
 * With --to-prefix (S3 only) the key envelope and v2 objects are written under
 * another S3_PREFIX of the same bucket, leaving the source prefix untouched.
 */
type Options = {
  dryRun: boolean;
  verify: boolean;
  deleteLegacy: boolean;
  concurrency: number;
  toPrefix?: string;
};

function normalizePrefix(prefix: string): string {
  return prefix ? prefix.replace(/\/+$/, "") + "/" : "";
}

function parseArgs(argv: string[]): Options {
  const concurrencyIndex = argv.indexOf("--concurrency");
  const toPrefixIndex = argv.indexOf("--to-prefix");
  return {
    toPrefix: toPrefixIndex >= 0 ? argv[toPrefixIndex + 1] : undefined,
    dryRun: argv.includes("--dry-run"),
    verify: argv.includes("--verify"),
    deleteLegacy: argv.includes("--delete-legacy"),
    concurrency:
      concurrencyIndex >= 0 ? Number(argv[concurrencyIndex + 1]) || 16 : 16,
  };
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        await task(items[index]);
      }
    })
  );
}

async function withRetry(action: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await action();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }
  throw lastError;
}

async function copyObject(
  storage: ObjectStorage,
  fromKey: string,
  toKey: string
): Promise<void> {
  if (storage.copy) {
    await storage.copy(fromKey, toKey);
    return;
  }
  await storage.write(toKey, await storage.read(fromKey), "application/octet-stream");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const passphrase = process.env.CACHE_ENCRYPTION_PASSPHRASE;
  if (!passphrase) throw new Error("CACHE_ENCRYPTION_PASSPHRASE is required");

  const config = backendConfigFromEnv();
  const storage = createStorage(config, false);

  // Objects are read and listed through `storage` (source prefix) and written
  // through `target`; `copyToTarget` copies between the two server-side.
  let target: ObjectStorage = storage;
  let copyToTarget = (fromKey: string, toKey: string) =>
    copyObject(storage, fromKey, toKey);
  if (options.toPrefix !== undefined) {
    if (config.kind !== "s3") throw new Error("--to-prefix requires CACHE_BACKEND=s3");
    if (options.deleteLegacy) {
      throw new Error("--delete-legacy cannot be combined with --to-prefix");
    }
    const sourcePrefix = normalizePrefix(config.prefix);
    const targetPrefix = normalizePrefix(options.toPrefix);
    if (!targetPrefix || targetPrefix === sourcePrefix) {
      throw new Error("--to-prefix must name a non-empty prefix different from S3_PREFIX");
    }
    if (targetPrefix.startsWith(sourcePrefix) || sourcePrefix.startsWith(targetPrefix)) {
      throw new Error("--to-prefix must not overlap S3_PREFIX");
    }
    const bucketRoot = new S3Storage({ ...config, prefix: "" });
    target = new S3Storage({ ...config, prefix: options.toPrefix });
    copyToTarget = (fromKey, toKey) =>
      bucketRoot.copy(sourcePrefix + fromKey, targetPrefix + toKey);
    // eslint-disable-next-line no-console
    console.log(`Copying s3://${config.bucket}/${sourcePrefix} -> s3://${config.bucket}/${targetPrefix}`);
  }
  const envelope = JSON.parse(
    (await storage.read(MASTER_KEY_OBJECT)).toString("utf8")
  ) as MasterKeyEnvelope;
  let masterKey: Buffer;
  try {
    masterKey = unwrapMasterKey(envelope, passphrase);
  } catch {
    throw new Error("Failed to unlock cache master key: wrong passphrase or corrupt envelope");
  }
  const pathCipher = new PathCipher(masterKey);

  if (target !== storage) {
    // Without the same envelope the target would get a fresh master key and
    // could never decrypt the copied objects.
    if (await target.exists(MASTER_KEY_OBJECT)) {
      const existing = await target.read(MASTER_KEY_OBJECT);
      if (!existing.equals(await storage.read(MASTER_KEY_OBJECT))) {
        throw new Error("Target prefix already has a different master-key envelope");
      }
    } else if (!options.dryRun) {
      await withRetry(() => copyToTarget(MASTER_KEY_OBJECT, MASTER_KEY_OBJECT));
      // eslint-disable-next-line no-console
      console.log("Copied master-key envelope");
    }
  }

  const { keys, deltaKeys } = await loadLegacyManifest(storage, masterKey);
  const legacyObjects = new Set(await storage.list(LEGACY_OBJECT_PREFIX));
  const existingV2 = new Set(await target.list(ENCRYPTED_PATH_PREFIX));
  // eslint-disable-next-line no-console
  console.log(
    `Legacy manifest keys=${keys.size} deltas=${deltaKeys.length}` +
      ` legacyObjects=${legacyObjects.size} existingV2=${existingV2.size}` +
      (options.dryRun ? " [dry-run]" : "")
  );

  let copied = 0;
  let skipped = 0;
  let missing = 0;
  let failed = 0;
  let verified = 0;
  let done = 0;
  const referenced = new Set<string>();
  await runPool([...keys], options.concurrency, async (key) => {
    const legacyKey = legacyObjectKey(key, masterKey);
    referenced.add(legacyKey);
    try {
      const targetKey = pathCipher.encryptKey(key);
      if (existingV2.has(targetKey)) {
        skipped += 1;
      } else if (!legacyObjects.has(legacyKey)) {
        missing += 1;
        // eslint-disable-next-line no-console
        console.warn(`  MISSING legacy object for ${key}`);
        return;
      } else {
        if (!options.dryRun) {
          await withRetry(() => copyToTarget(legacyKey, targetKey));
        }
        copied += 1;
      }
      if (options.verify && !options.dryRun) {
        decryptObject(await target.read(targetKey), masterKey);
        verified += 1;
      }
    } catch (error) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(`  FAIL ${key}: ${error instanceof Error ? error.message : error}`);
    } finally {
      done += 1;
      if (done % 1000 === 0 || done === keys.size) {
        // eslint-disable-next-line no-console
        console.log(`  progress ${done}/${keys.size}`);
      }
    }
  });

  const orphans = [...legacyObjects].filter((key) => !referenced.has(key));
  // eslint-disable-next-line no-console
  console.log(
    `Copy ${options.dryRun ? "planned" : "done"}. copied=${copied} skipped=${skipped}` +
      ` missing=${missing} failed=${failed}` +
      (options.verify ? ` verified=${verified}` : "") +
      ` unreferencedLegacyObjects=${orphans.length}`
  );
  if (failed > 0) {
    process.exitCode = 1;
    if (options.deleteLegacy) {
      // eslint-disable-next-line no-console
      console.error("Not deleting legacy objects because some copies failed.");
    }
    return;
  }

  if (options.deleteLegacy) {
    const legacyKeys = [...legacyObjects, ...deltaKeys];
    if (options.dryRun) {
      // eslint-disable-next-line no-console
      console.log(`Would delete ${legacyKeys.length} legacy objects and the base manifest`);
      return;
    }
    await runPool(legacyKeys, options.concurrency, (key) =>
      withRetry(() => storage.delete(key))
    );
    // The manifest goes last so an interrupted run can resume from it.
    await storage.delete(LEGACY_MANIFEST_OBJECT);
    // eslint-disable-next-line no-console
    console.log(`Deleted ${legacyKeys.length} legacy objects and the base manifest`);
  }
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
