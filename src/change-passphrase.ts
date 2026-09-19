import {
  backendConfigFromEnv,
  createStorage,
} from "./storage";
import {
  MASTER_KEY_OBJECT,
  type MasterKeyEnvelope,
  unwrapMasterKey,
  wrapMasterKey,
} from "./storage/crypto-format";

async function main(): Promise<void> {
  const oldPassphrase = process.env.CACHE_ENCRYPTION_OLD_PASSPHRASE;
  const newPassphrase = process.env.CACHE_ENCRYPTION_NEW_PASSPHRASE;
  if (!oldPassphrase || !newPassphrase) {
    throw new Error(
      "CACHE_ENCRYPTION_OLD_PASSPHRASE and CACHE_ENCRYPTION_NEW_PASSPHRASE are required"
    );
  }
  if (newPassphrase.length < 12) {
    throw new Error("The new passphrase must be at least 12 characters");
  }

  const storage = createStorage(backendConfigFromEnv(), false);
  const envelope = JSON.parse(
    (await storage.read(MASTER_KEY_OBJECT)).toString("utf8")
  ) as MasterKeyEnvelope;
  const masterKey = unwrapMasterKey(envelope, oldPassphrase);
  const replacement = wrapMasterKey(masterKey, newPassphrase);
  await storage.write(
    MASTER_KEY_OBJECT,
    Buffer.from(`${JSON.stringify(replacement)}\n`),
    "application/json"
  );
  // eslint-disable-next-line no-console
  console.log("Master key rewrapped. Restart the server with the new passphrase.");
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
