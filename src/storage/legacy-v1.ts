import { createHmac, hkdfSync } from "crypto";
import { decryptObject } from "./crypto-format";
import type { ObjectStorage } from "./types";

/**
 * Read-only access to the v1 encrypted layout: HMAC (one-way) object names
 * under `objects/` plus an encrypted manifest and append-only deltas that
 * hold the logical key list. Only the v1 -> v2 path migration uses this.
 */
export const LEGACY_OBJECT_PREFIX = "objects/";
export const LEGACY_MANIFEST_OBJECT = ".img-preview-manifest-v1";
export const LEGACY_MANIFEST_DELTA_PREFIX = ".img-preview-manifest-delta-v1/";

export function legacyObjectKey(logicalKey: string, masterKey: Buffer): string {
  const pathKey = Buffer.from(
    hkdfSync(
      "sha256",
      masterKey,
      Buffer.from("img-preview-v1"),
      Buffer.from("path-hmac"),
      32
    )
  );
  const digest = createHmac("sha256", pathKey)
    .update(logicalKey)
    .digest("base64url");
  return `${LEGACY_OBJECT_PREFIX}${digest}`;
}

type ManifestDelta = { version: 1; added: string[]; deleted: string[] };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isManifestDelta(value: unknown): value is ManifestDelta {
  if (!value || typeof value !== "object") return false;
  const delta = value as Record<string, unknown>;
  return (
    delta.version === 1 && isStringArray(delta.added) && isStringArray(delta.deleted)
  );
}

/** Merge the v1 base manifest with every delta, in name (= time) order. */
export async function loadLegacyManifest(
  storage: ObjectStorage,
  masterKey: Buffer
): Promise<{ keys: Set<string>; deltaKeys: string[] }> {
  const keys = new Set<string>();
  if (await storage.exists(LEGACY_MANIFEST_OBJECT)) {
    const base = JSON.parse(
      decryptObject(await storage.read(LEGACY_MANIFEST_OBJECT), masterKey).toString("utf8")
    ) as unknown;
    if (!isStringArray(base)) throw new Error("Legacy manifest is invalid");
    for (const key of base) keys.add(key);
  }

  const deltaKeys = (await storage.list(LEGACY_MANIFEST_DELTA_PREFIX)).sort();
  const deltas: ManifestDelta[] = new Array(deltaKeys.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(32, deltaKeys.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= deltaKeys.length) return;
        const raw = JSON.parse(
          decryptObject(await storage.read(deltaKeys[index]), masterKey).toString("utf8")
        ) as unknown;
        if (!isManifestDelta(raw)) {
          throw new Error(`Legacy manifest delta is invalid: ${deltaKeys[index]}`);
        }
        deltas[index] = raw;
      }
    })
  );
  for (const delta of deltas) {
    for (const key of delta.added) keys.add(key);
    for (const key of delta.deleted) keys.delete(key);
  }
  return { keys, deltaKeys };
}
