import type { AppConfig } from "../config/config.js";
import { Repository, type PersistenceBackend } from "../repository/store.js";
import { boundedOperation } from "../core/bounded-operation.js";
import { PostgresPersistence } from "./postgres.js";
import { PostgresRecordPersistence } from "./postgres-records.js";
import { FirestorePersistence } from "./firestore.js";
import { FirestoreRecordPersistence } from "./firestore-records.js";

/** Bounded application startup, including late-resource disposal. No driver
 * fallback, import, migration, credential discovery or deployment is implied. */
export function openApplicationRepository(config: AppConfig, timeoutMs = 30_000, options: { reuseVerifiedFirestoreImages?: boolean } = {}): Promise<Repository> {
  let persistence: PersistenceBackend | null = null, repository: Repository | undefined, abandoned = false;
  const dispose = () => { void (repository ? repository.close() : persistence?.close())?.catch(() => {}); };
  return boundedOperation(async () => {
    try {
      if (config.storageDriver === "postgres") persistence = await PostgresPersistence.open(config.databaseURL, config.storageEncryptionKey);
      else if (config.storageDriver === "postgres-records") persistence = await PostgresRecordPersistence.open(config.databaseURL, config.storageEncryptionKey);
      else if (config.storageDriver === "firestore-records") persistence = await FirestoreRecordPersistence.open(config.storageEncryptionKey, {
        projectId: config.firestoreProjectId!, databaseId: config.firestoreDatabaseId!, workspaceId: config.firestoreWorkspaceId!,
      }, { initializationTimeoutMs: timeoutMs, reuseVerifiedImages: options.reuseVerifiedFirestoreImages === true, ...(config.firestoreContentFormat ? {contentFormat: config.firestoreContentFormat} : {}), ...(config.firestoreKeyFile ? { keyFilename: config.firestoreKeyFile } : {}), ...(config.firestoreKeyJson ? { credentials: config.firestoreKeyJson } : {}) });
      else if (config.storageDriver === "firestore") persistence = await FirestorePersistence.open({ projectId: config.firestoreProjectId!,
        ...(config.firestoreKeyFile ? { keyFilename: config.firestoreKeyFile } : {}), ...(config.firestoreKeyJson ? { credentials: config.firestoreKeyJson } : {}),
        ...(config.firestoreEncryptionKey ? { encryptionKey: config.firestoreEncryptionKey } : {}) });
      if (abandoned) { dispose(); throw new Error("Application storage initialization was abandoned"); }
      repository = await Repository.open(persistence);
      if (abandoned) { dispose(); throw new Error("Application repository initialization was abandoned"); }
      repository.assertAuthority(); return repository;
    } catch (error) { dispose(); throw error; }
  }, { timeoutMs, label: "Application repository startup", onAbandon: () => { abandoned = true; dispose(); }, onLateSettlement: dispose });
}
