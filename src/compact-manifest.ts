import { backendConfigFromEnv, createStorage, EncryptedStorage } from "./storage";

async function main(): Promise<void> {
  const storage = createStorage(backendConfigFromEnv());
  if (!(storage instanceof EncryptedStorage)) {
    throw new Error("compact-manifest requires CACHE_ENCRYPTION=true");
  }
  const result = await storage.compactManifest();
  // eslint-disable-next-line no-console
  console.log(
    `Manifest compacted: keys=${result.keys} appliedDeltas=${result.deltas}`
  );
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
