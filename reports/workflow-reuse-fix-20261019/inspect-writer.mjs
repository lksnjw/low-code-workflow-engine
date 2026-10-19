import { readFile } from "node:fs/promises";
import { loadFunctionConfig } from "../../backend-ts/src/firebase/config.ts";
import { FirestoreRecordStore } from "../../backend-ts/src/storage/firestore-record-store.ts";
import { FirestoreRecordCodec } from "../../backend-ts/src/storage/firestore-record-codec.ts";
import { stagingOperatorCredentials } from "../../ops/deployment/firebase/staging-cloud-client.mjs";
import { resolve } from "node:path";
const config = loadFunctionConfig(await readFile(new URL("../../ops/deployment/firebase/runtime-config.local.json", import.meta.url), "utf8"), resolve("backend-ts/.functions/assets"));
const namespace = { projectId: config.firestoreProjectId, databaseId: config.firestoreDatabaseId, workspaceId: config.firestoreWorkspaceId };
const store = FirestoreRecordStore.create(config.storageEncryptionKey, namespace, { credentials: stagingOperatorCredentials() }, config.firestoreContentFormat);
try {
  const codec = new FirestoreRecordCodec(config.storageEncryptionKey, namespace, config.firestoreContentFormat);
  const row = await store.db.doc(`workspaces/${namespace.workspaceId}/lcwe_runtime/writer`).get();
  const lease = codec.decodeHead(row.data());
  console.log(JSON.stringify({ state: lease.state, heldForMs: Date.now() - lease.acquiredAt, expiresInMs: lease.expiresAt - Date.now(), generation: lease.generation, sequence: lease.sequence }));
} finally { await store.close(); }
