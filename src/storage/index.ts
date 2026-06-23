export type {
  BackendConfig,
  FsBackendConfig,
  ObjectStorage,
  S3BackendConfig,
} from "./types";
export { FsStorage } from "./fs-storage";
export { S3Storage } from "./s3-storage";
export {
  backendConfigFromEnv,
  createStorage,
  createStorageFromEnv,
} from "./factory";
