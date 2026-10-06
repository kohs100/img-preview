import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  pbkdf2Sync,
  randomBytes,
} from "crypto";
import { Eme, EME_MAX_BYTES } from "./eme";

export const ENCRYPTED_OBJECT_MAGIC = Buffer.from("IPV1");
export const MASTER_KEY_OBJECT = ".img-preview-key-v1.json";
/** Every object stored under an EME-encrypted (reversible) path lives here. */
export const ENCRYPTED_PATH_PREFIX = "v2/";
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
const HKDF_SALT = Buffer.from("img-preview-v1");

function deriveSubkey(masterKey: Buffer, purpose: string, length = 32): Buffer {
  return Buffer.from(
    hkdfSync("sha256", masterKey, HKDF_SALT, Buffer.from(purpose), length)
  );
}

export function deriveContentKey(masterKey: Buffer): Buffer {
  return deriveSubkey(masterKey, "content-encryption");
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

/**
 * Reversible, deterministic path encryption in the style of rclone crypt:
 * every "/"-separated segment is PKCS#7 padded, EME-encrypted with one fixed
 * tweak and encoded as unpadded lowercase base32hex. Depth and equal segment
 * names stay visible; segment contents and lengths beyond 16-byte blocks do not.
 */
export class PathCipher {
  private readonly eme: Eme;

  private readonly tweak: Buffer;

  constructor(masterKey: Buffer) {
    const material = deriveSubkey(masterKey, "path-eme-v2", 48);
    this.eme = new Eme(material.subarray(0, 32));
    this.tweak = material.subarray(32);
  }

  encryptKey(logicalKey: string): string {
    return ENCRYPTED_PATH_PREFIX + this.encryptSegments(logicalKey.split("/"));
  }

  /** Encrypted form of whole leading segments, for prefix listing. */
  encryptSegments(segments: string[]): string {
    return segments.map((segment) => this.encryptSegment(segment)).join("/");
  }

  /** Returns null for names that are not valid encrypted paths. */
  decryptKey(physicalKey: string): string | null {
    if (!physicalKey.startsWith(ENCRYPTED_PATH_PREFIX)) return null;
    const segments: string[] = [];
    for (const encoded of physicalKey.slice(ENCRYPTED_PATH_PREFIX.length).split("/")) {
      const segment = this.decryptSegment(encoded);
      if (segment === null) return null;
      segments.push(segment);
    }
    return segments.join("/");
  }

  private encryptSegment(segment: string): string {
    if (!segment) throw new Error("Storage keys must not contain empty path segments");
    const plaintext = Buffer.from(segment, "utf8");
    const padding = 16 - (plaintext.length % 16);
    const padded = Buffer.concat([plaintext, Buffer.alloc(padding, padding)]);
    if (padded.length > EME_MAX_BYTES) {
      throw new Error(`Storage key segment is too long to encrypt (${plaintext.length} bytes)`);
    }
    return encodeBase32Hex(this.eme.encrypt(this.tweak, padded));
  }

  private decryptSegment(encoded: string): string | null {
    const ciphertext = decodeBase32Hex(encoded);
    if (
      !ciphertext ||
      ciphertext.length === 0 ||
      ciphertext.length % 16 !== 0 ||
      ciphertext.length > EME_MAX_BYTES
    ) {
      return null;
    }
    const padded = this.eme.decrypt(this.tweak, ciphertext);
    const padding = padded[padded.length - 1];
    if (padding < 1 || padding > 16) return null;
    for (let i = padded.length - padding; i < padded.length; i += 1) {
      if (padded[i] !== padding) return null;
    }
    try {
      const segment = UTF8.decode(padded.subarray(0, padded.length - padding));
      return segment && !segment.includes("/") ? segment : null;
    } catch {
      return null;
    }
  }
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

function encodeBase32Hex(data: Buffer): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32HEX[(value << (5 - bits)) & 31];
  return out;
}

/** Strict decoder: only canonical lowercase, unpadded encodings round-trip. */
function decodeBase32Hex(text: string): Buffer | null {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    const digit = BASE32HEX.indexOf(char);
    if (digit < 0) return null;
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  const data = Buffer.from(bytes);
  return encodeBase32Hex(data) === text ? data : null;
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
