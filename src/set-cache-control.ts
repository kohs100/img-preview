import "dotenv/config";
import { S3Client, ListObjectsV2Command, HeadObjectCommand, CopyObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { backendConfigFromEnv } from "./storage/factory";
import { MASTER_KEY_OBJECT, PathCipher, unwrapMasterKey, type MasterKeyEnvelope } from "./storage/crypto-format";
import { imageCacheControl } from "./storage/cache-policy";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const config = backendConfigFromEnv("s3");
  if (config.kind !== "s3") throw new Error("S3 configuration required");
  const client = new S3Client({
    region: config.region, endpoint: config.endpoint, forcePathStyle: config.forcePathStyle,
    credentials: config.accessKeyId && config.secretAccessKey
      ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } : undefined,
  });
  const prefix = config.prefix ? config.prefix.replace(/\/+$/, "") + "/" : "";
  let cipher: PathCipher | undefined;
  if (/^(true|1|yes|on)$/i.test(process.env.CACHE_ENCRYPTION ?? "")) {
    const passphrase = process.env.CACHE_ENCRYPTION_PASSPHRASE;
    if (!passphrase) throw new Error("Encryption passphrase required");
    const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: prefix + MASTER_KEY_OBJECT }));
    const envelope = JSON.parse(await response.Body!.transformToString()) as MasterKeyEnvelope;
    cipher = new PathCipher(unwrapMasterKey(envelope, passphrase));
  }
  let token: string | undefined;
  let scanned = 0, changed = 0, skipped = 0, failed = 0;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, ContinuationToken: token }));
    const objects = page.Contents ?? [];
    for (let offset = 0; offset < objects.length; offset += 64) {
      await Promise.all(objects.slice(offset, offset + 64).map(async (object) => {
        if (!object.Key) return;
        scanned++;
        const bare = object.Key.slice(prefix.length);
        const logical = bare.startsWith("v2/") ? cipher?.decryptKey(bare) : bare;
        if (!logical) { skipped++; return; }
        try {
          const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: object.Key }));
          const policy = imageCacheControl(logical);
          if (head.CacheControl === policy) { skipped++; return; }
          if (apply) {
            await client.send(new CopyObjectCommand({
              Bucket: config.bucket, Key: object.Key,
              CopySource: [config.bucket, ...object.Key.split("/")].map(encodeURIComponent).join("/"),
              CopySourceIfMatch: head.ETag, MetadataDirective: "REPLACE",
              CacheControl: policy, ContentType: head.ContentType, Metadata: head.Metadata,
              ContentDisposition: head.ContentDisposition, ContentEncoding: head.ContentEncoding,
              ContentLanguage: head.ContentLanguage, Expires: head.Expires,
            }));
            const verified = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: object.Key }));
            if (verified.CacheControl !== policy || verified.ETag !== head.ETag || verified.ContentLength !== head.ContentLength) {
              throw new Error("Metadata verification failed");
            }
          }
          changed++;
        } catch (error) {
          failed++;
          console.error(`Object ${scanned}: ${error instanceof Error ? error.name + ": " + error.message : "failed"}`);
        }
      }));
    }
    console.log(JSON.stringify({ apply, scanned, changed, skipped, failed }));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  client.destroy();
  if (failed) process.exitCode = 1;
}
void main().catch((error) => { console.error(error instanceof Error ? error.message : "Failed"); process.exitCode = 1; });
