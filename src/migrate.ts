import {
  backendConfigFromEnv,
  createStorage,
  EncryptedStorage,
} from "./storage";
import type { ObjectStorage } from "./storage";

type MigrateOptions = {
  from: "fs" | "s3";
  to: "fs" | "s3";
  prefix: string;
  overwrite: boolean;
  dryRun: boolean;
  concurrency: number;
  encryptDestination: boolean;
};

function parseArgs(argv: string[]): MigrateOptions {
  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [name, inlineValue] = arg.slice(2).split("=", 2);
      if (inlineValue !== undefined) {
        flags.set(name, inlineValue);
      } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        flags.set(name, argv[i + 1]);
        i += 1;
      } else {
        flags.set(name, "true");
      }
    } else {
      positional.push(arg);
    }
  }

  const from = (flags.get("from") ?? positional[0]) as "fs" | "s3" | undefined;
  const to = (flags.get("to") ?? positional[1]) as "fs" | "s3" | undefined;

  if (from !== "fs" && from !== "s3") {
    throw new Error("Source backend must be 'fs' or 's3'");
  }
  if (to !== "fs" && to !== "s3") {
    throw new Error("Destination backend must be 'fs' or 's3'");
  }
  if (from === to) {
    throw new Error("Source and destination backends must differ");
  }

  return {
    from,
    to,
    prefix: flags.get("prefix") ?? "",
    overwrite: flags.get("overwrite") === "true" || flags.has("overwrite"),
    dryRun: flags.get("dry-run") === "true" || flags.has("dry-run"),
    concurrency: Number(flags.get("concurrency") ?? "8") || 8,
    encryptDestination:
      flags.get("encrypt-destination") === "true" ||
      flags.has("encrypt-destination"),
  };
}

async function migrateKey(
  key: string,
  source: ObjectStorage,
  dest: ObjectStorage,
  options: MigrateOptions,
  knownExisting?: Set<string>
): Promise<"copied" | "skipped"> {
  const alreadyExists = knownExisting
    ? knownExisting.has(key)
    : await dest.exists(key);
  if (!options.overwrite && alreadyExists) {
    return "skipped";
  }
  if (options.dryRun) {
    return "copied";
  }
  const data = await source.read(key);
  const contentType = key.endsWith(".json")
    ? "application/json"
    : undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await dest.write(key, data, contentType);
      return "copied";
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const source = createStorage(backendConfigFromEnv(options.from), false);
  const rawDest = createStorage(backendConfigFromEnv(options.to), false);
  let dest: ObjectStorage = rawDest;
  if (options.encryptDestination) {
    const passphrase = process.env.CACHE_ENCRYPTION_PASSPHRASE;
    if (!passphrase) {
      throw new Error(
        "CACHE_ENCRYPTION_PASSPHRASE is required with --encrypt-destination"
      );
    }
    const encryptedDest = new EncryptedStorage(rawDest, passphrase);
    await encryptedDest.ensureReady();
    dest = encryptedDest;
  }

  // eslint-disable-next-line no-console
  console.log(
    `Migrating ${source.backendName} -> ${dest.backendName}` +
      (options.prefix ? ` (prefix: ${options.prefix})` : "") +
      (options.dryRun ? " [dry-run]" : "")
  );

  const keys = await source.list(options.prefix);
  // eslint-disable-next-line no-console
  console.log(`Found ${keys.length} objects to migrate`);
  // Encrypted names are cheap to list and decrypt, so one listing replaces a
  // HEAD request per key.
  const knownExisting =
    dest instanceof EncryptedStorage
      ? new Set(await dest.list(options.prefix))
      : undefined;
  if (knownExisting) {
    // eslint-disable-next-line no-console
    console.log(`Found ${knownExisting.size} existing encrypted objects`);
  }

  let copied = 0;
  let skipped = 0;
  let failed = 0;
  let lastReported = 0;

  for (let i = 0; i < keys.length; i += options.concurrency) {
    const batch = keys.slice(i, i + options.concurrency);
    const results = await Promise.allSettled(
      batch.map((key) =>
        migrateKey(key, source, dest, options, knownExisting)
      )
    );
    for (let j = 0; j < results.length; j += 1) {
      const result = results[j];
      if (result.status === "rejected") {
        failed += 1;
        // eslint-disable-next-line no-console
        console.error(`  FAIL ${batch[j]}: ${result.reason}`);
      } else if (result.value === "copied") {
        copied += 1;
      } else {
        skipped += 1;
      }
    }
    const completed = Math.min(i + options.concurrency, keys.length);
    if (completed === keys.length || completed - lastReported >= 1000) {
      lastReported = completed;
      // eslint-disable-next-line no-console
      console.log(`  progress ${completed}/${keys.length}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `Done. copied=${copied} skipped=${skipped} failed=${failed}` +
      (options.dryRun ? " (dry-run, nothing written)" : "")
  );
  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
