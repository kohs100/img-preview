import { randomBytes } from "crypto";
import type { ObjectStorage, RedirectEndpoints } from "./types";
import {
  decryptObject,
  ENCRYPTED_PATH_PREFIX,
  encryptObject,
  MASTER_KEY_OBJECT,
  type MasterKeyEnvelope,
  PathCipher,
  unwrapMasterKey,
  wrapMasterKey,
} from "./crypto-format";

/**
 * Application-layer encryption for an untrusted store. Object bodies are
 * AES-GCM sealed and paths are EME-encrypted per segment, so the logical key
 * list is recovered by listing and decrypting names; no manifest is kept.
 */
export class EncryptedStorage implements ObjectStorage {
  readonly backendName: string;
  private readonly ready: Promise<void>;
  private masterKey!: Buffer;
  private pathCipher!: PathCipher;

  constructor(
    private readonly inner: ObjectStorage,
    private readonly passphrase: string
  ) {
    this.backendName = `${inner.backendName}+encrypted`;
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    if (await this.inner.exists(MASTER_KEY_OBJECT)) {
      const envelope = JSON.parse(
        (await this.inner.read(MASTER_KEY_OBJECT)).toString("utf8")
      ) as MasterKeyEnvelope;
      try {
        this.masterKey = unwrapMasterKey(envelope, this.passphrase);
      } catch {
        throw new Error("Failed to unlock cache master key: wrong passphrase or corrupt envelope");
      }
    } else {
      this.masterKey = randomBytes(32);
      const envelope = wrapMasterKey(this.masterKey, this.passphrase);
      await this.inner.write(
        MASTER_KEY_OBJECT,
        Buffer.from(`${JSON.stringify(envelope)}\n`),
        "application/json"
      );
    }
    this.pathCipher = new PathCipher(this.masterKey);
  }

  async ensureReady(): Promise<void> {
    await this.ready;
  }

  private physicalKey(key: string): string {
    return this.pathCipher.encryptKey(key);
  }

  async read(key: string): Promise<Buffer> {
    await this.ready;
    return decryptObject(await this.inner.read(this.physicalKey(key)), this.masterKey);
  }

  async write(
    key: string,
    data: Buffer,
    _contentType?: string,
    onPhase?: (phase: "encrypting" | "uploading") => void
  ): Promise<void> {
    await this.ready;
    const physicalKey = this.physicalKey(key);
    onPhase?.("encrypting");
    const encrypted = encryptObject(data, this.masterKey);
    await this.inner.write(physicalKey, encrypted, "application/octet-stream", onPhase);
  }

  async exists(key: string): Promise<boolean> {
    await this.ready;
    return this.inner.exists(this.physicalKey(key));
  }

  /**
   * Lists by decrypting object names. Whole leading segments of `prefix` are
   * encrypted to narrow the backend listing; a trailing partial segment is
   * matched after decryption. Names that fail to decrypt are skipped.
   */
  async list(prefix = ""): Promise<string[]> {
    await this.ready;
    const wholeSegments = prefix.split("/").slice(0, -1);
    const physicalPrefix =
      ENCRYPTED_PATH_PREFIX +
      (wholeSegments.length > 0
        ? `${this.pathCipher.encryptSegments(wholeSegments)}/`
        : "");
    const keys: string[] = [];
    for (const physicalKey of await this.inner.list(physicalPrefix)) {
      const key = this.pathCipher.decryptKey(physicalKey);
      if (key !== null && key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  }

  async delete(key: string): Promise<void> {
    await this.ready;
    await this.inner.delete(this.physicalKey(key));
  }

  async getRedirectUrl(key: string, endpointId?: string): Promise<string | null> {
    await this.ready;
    return this.inner.getRedirectUrl?.(this.physicalKey(key), endpointId) ?? null;
  }

  redirectEndpoints(): RedirectEndpoints | null {
    return this.inner.redirectEndpoints?.() ?? null;
  }

  /** Return the authenticated ciphertext container without decrypting it. */
  async readEncrypted(key: string): Promise<Buffer> {
    await this.ready;
    return this.inner.read(this.physicalKey(key));
  }

  async getMasterKeyEnvelope(): Promise<MasterKeyEnvelope> {
    await this.ready;
    return JSON.parse(
      (await this.inner.read(MASTER_KEY_OBJECT)).toString("utf8")
    ) as MasterKeyEnvelope;
  }
}
