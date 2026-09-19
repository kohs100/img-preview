import { randomBytes } from "crypto";
import type { ObjectStorage } from "./types";
import {
  decryptObject,
  encryptObject,
  MANIFEST_OBJECT,
  MASTER_KEY_OBJECT,
  type MasterKeyEnvelope,
  opaqueObjectKey,
  unwrapMasterKey,
  wrapMasterKey,
} from "./crypto-format";

/** Application-layer encryption and opaque-key adapter for an untrusted store. */
export class EncryptedStorage implements ObjectStorage {
  readonly backendName: string;
  private readonly ready: Promise<void>;
  private masterKey!: Buffer;
  private logicalKeys = new Set<string>();
  private manifestWrite = Promise.resolve();
  private manifestLoad?: Promise<void>;

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
  }

  private async ensureManifestLoaded(): Promise<void> {
    await this.ready;
    if (!this.manifestLoad) this.manifestLoad = this.loadManifest();
    await this.manifestLoad;
  }

  private async loadManifest(): Promise<void> {
    if (await this.inner.exists(MANIFEST_OBJECT)) {
      const raw = decryptObject(
        await this.inner.read(MANIFEST_OBJECT),
        this.masterKey
      );
      const keys = JSON.parse(raw.toString("utf8")) as unknown;
      if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) {
        throw new Error("Encrypted storage manifest is invalid");
      }
      this.logicalKeys = new Set(keys);
    }
  }

  async ensureReady(): Promise<void> {
    await this.ready;
  }

  private physicalKey(key: string): string {
    return opaqueObjectKey(key, this.masterKey);
  }

  private async persistManifest(): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify([...this.logicalKeys].sort()));
    await this.inner.write(
      MANIFEST_OBJECT,
      encryptObject(plaintext, this.masterKey),
      "application/octet-stream"
    );
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
    await this.ensureManifestLoaded();
    const wasNew = !this.logicalKeys.has(key);
    await this.writeDeferred(key, data, onPhase);
    if (wasNew) {
      this.manifestWrite = this.manifestWrite
        .catch(() => undefined)
        .then(() => this.persistManifest());
      try {
        await this.manifestWrite;
      } catch (error) {
        if (wasNew) this.logicalKeys.delete(key);
        throw error;
      }
    }
  }

  /**
   * Write an encrypted object and update the in-memory index without uploading
   * the manifest. Bulk migrations call commitManifest once after all objects.
   */
  async writeDeferred(
    key: string,
    data: Buffer,
    onPhase?: (phase: "encrypting" | "uploading") => void
  ): Promise<void> {
    await this.ready;
    onPhase?.("encrypting");
    const encrypted = encryptObject(data, this.masterKey);
    await this.inner.write(
      this.physicalKey(key),
      encrypted,
      "application/octet-stream",
      onPhase
    );
    this.logicalKeys.add(key);
  }

  /** Add already-uploaded logical keys and persist one encrypted manifest. */
  async commitManifest(keys: Iterable<string> = []): Promise<void> {
    await this.ensureManifestLoaded();
    for (const key of keys) this.logicalKeys.add(key);
    this.manifestWrite = this.manifestWrite
      .catch(() => undefined)
      .then(() => this.persistManifest());
    await this.manifestWrite;
  }

  /** Bulk-resolve which logical keys already have opaque objects in storage. */
  async findExisting(keys: Iterable<string>): Promise<Set<string>> {
    await this.ready;
    const physicalKeys = new Set(await this.inner.list("objects/"));
    const existing = new Set<string>();
    for (const key of keys) {
      if (physicalKeys.has(this.physicalKey(key))) existing.add(key);
    }
    return existing;
  }

  async exists(key: string): Promise<boolean> {
    await this.ready;
    return this.inner.exists(this.physicalKey(key));
  }

  async list(prefix = ""): Promise<string[]> {
    await this.ensureManifestLoaded();
    const keys = [...this.logicalKeys];
    return prefix ? keys.filter((key) => key.startsWith(prefix)) : keys;
  }

  async delete(key: string): Promise<void> {
    await this.ensureManifestLoaded();
    await this.inner.delete(this.physicalKey(key));
    if (this.logicalKeys.delete(key)) {
      this.manifestWrite = this.manifestWrite
        .catch(() => undefined)
        .then(() => this.persistManifest());
      await this.manifestWrite;
    }
  }

  async getRedirectUrl(key: string): Promise<string | null> {
    await this.ready;
    return this.inner.getRedirectUrl?.(this.physicalKey(key)) ?? null;
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
