import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  pbkdf2Sync,
  randomBytes,
} from "crypto";

export const ENCRYPTED_OBJECT_MAGIC = Buffer.from("IPV1");
export const MASTER_KEY_OBJECT = ".img-preview-key-v1.json";
export const MANIFEST_OBJECT = ".img-preview-manifest-v1";
export const MANIFEST_DELTA_PREFIX = ".img-preview-manifest-delta-v1/";
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
const HKDF_SALT = Buffer.from("img-preview-v1");

function deriveSubkey(masterKey: Buffer, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", masterKey, HKDF_SALT, Buffer.from(purpose), 32)
  );
}

export function deriveContentKey(masterKey: Buffer): Buffer {
  return deriveSubkey(masterKey, "content-encryption");
}

function derivePathKey(masterKey: Buffer): Buffer {
  return deriveSubkey(masterKey, "path-hmac");
}

export type MasterKeyEnvelope = {
  version: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
};

function encryptAesGcm(plaintext: Buffer, key: Buffer, aad?: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
}

function decryptAesGcm(payload: Buffer, key: Buffer, aad?: Buffer): Buffer {
  if (payload.length < 28) throw new Error("Encrypted payload is truncated");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(payload.length - 16);
  const ciphertext = payload.subarray(12, payload.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptObject(plaintext: Buffer, masterKey: Buffer): Buffer {
  return Buffer.concat([
    ENCRYPTED_OBJECT_MAGIC,
    encryptAesGcm(
      plaintext,
      deriveContentKey(masterKey),
      ENCRYPTED_OBJECT_MAGIC
    ),
  ]);
}

export function decryptObject(payload: Buffer, masterKey: Buffer): Buffer {
  if (!payload.subarray(0, 4).equals(ENCRYPTED_OBJECT_MAGIC)) {
    throw new Error("Object is not an img-preview encrypted object");
  }
  return decryptAesGcm(
    payload.subarray(4),
    deriveContentKey(masterKey),
    ENCRYPTED_OBJECT_MAGIC
  );
}

export function opaqueObjectKey(logicalKey: string, masterKey: Buffer): string {
  const digest = createHmac("sha256", derivePathKey(masterKey))
    .update(logicalKey)
    .digest("base64url");
  return `objects/${digest}`;
}

export function wrapMasterKey(
  masterKey: Buffer,
  passphrase: string,
  iterations = DEFAULT_PBKDF2_ITERATIONS
): MasterKeyEnvelope {
  const salt = randomBytes(16);
  const wrappingKey = pbkdf2Sync(passphrase, salt, iterations, 32, "sha256");
  const encrypted = encryptAesGcm(
    masterKey,
    wrappingKey,
    Buffer.from("img-preview-master-key-v1")
  );
  return {
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations,
    salt: salt.toString("base64"),
    iv: encrypted.subarray(0, 12).toString("base64"),
    ciphertext: encrypted.subarray(12).toString("base64"),
  };
}

export function unwrapMasterKey(
  envelope: MasterKeyEnvelope,
  passphrase: string
): Buffer {
  if (
    envelope.version !== 1 ||
    envelope.kdf !== "PBKDF2-SHA256" ||
    !Number.isSafeInteger(envelope.iterations) ||
    envelope.iterations < 100_000 ||
    envelope.iterations > 5_000_000
  ) {
    throw new Error("Unsupported master-key envelope");
  }
  const salt = Buffer.from(envelope.salt, "base64");
  const wrappingKey = pbkdf2Sync(
    passphrase,
    salt,
    envelope.iterations,
    32,
    "sha256"
  );
  return decryptAesGcm(
    Buffer.concat([
      Buffer.from(envelope.iv, "base64"),
      Buffer.from(envelope.ciphertext, "base64"),
    ]),
    wrappingKey,
    Buffer.from("img-preview-master-key-v1")
  );
}
