import { backendConfigFromEnv, createStorage, EncryptedStorage } from "./storage";
import { MANIFEST_OBJECT, MASTER_KEY_OBJECT } from "./storage/crypto-format";

async function main(): Promise<void> {
  const passphrase = process.env.CACHE_ENCRYPTION_PASSPHRASE;
  if (!passphrase) throw new Error("CACHE_ENCRYPTION_PASSPHRASE is required");
  if (passphrase.length < 12) throw new Error("Passphrase must be at least 12 characters");

  const keepPlaintext = process.argv.includes("--keep-plaintext");
  const raw = createStorage(backendConfigFromEnv(), false);
  const plaintextKeys = (await raw.list()).filter(
    (key) =>
      key !== MASTER_KEY_OBJECT &&
      key !== MANIFEST_OBJECT &&
      !key.startsWith("objects/")
  );
  const encrypted = new EncryptedStorage(raw, passphrase);

  let converted = 0;
  for (const key of plaintextKeys) {
    const data = await raw.read(key);
    await encrypted.write(key, data);
    if (!keepPlaintext) await raw.delete(key);
    converted += 1;
    // eslint-disable-next-line no-console
    console.log(`encrypted ${converted}/${plaintextKeys.length}`);
  }
  // eslint-disable-next-line no-console
  console.log(
    `Done. encrypted=${converted}, plaintext=${keepPlaintext ? "kept" : "removed"}`
  );
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
