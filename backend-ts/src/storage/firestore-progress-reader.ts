import type { AppConfig } from "../config/config.js";
import { boundedOperation } from "../core/bounded-operation.js";
import type { RepositoryState } from "../repository/store.js";
import { FirestoreRecordStore, type FirestoreRecordSnapshot } from "./firestore-record-store.js";
import { assembleFirestoreState } from "./firestore-record-layout.js";
import { checkedFirestoreState } from "./firestore-records.js";
import type { ChatOperation } from "../repository/store.js";
import { FirestoreChatCancellation } from "./firestore-chat-cancellation.js";
import type { RuntimeRecord } from "./execution-record-layout.js";
import { AsyncMutex } from "../repository/async-mutex.js";
import { scopedProgressView, type ScopedProgressRequest, type ScopedProgressView } from "./firestore-scoped-progress.js";

/** This interface deliberately has no mutation, writer, checkpoint, dispatch,
 * recovery or Repository authority marker. One snapshot contains both current
 * account permissions and progress, from the same committed head transaction. */
export interface ProgressSnapshotReader {
  snapshot(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<RepositoryState>;
  close(): Promise<void>;
  cancellationRequested?(operation: ChatOperation, signal?: AbortSignal): Promise<boolean>;
  metadataPage?(state: RepositoryState, kind: string, ownerId: string | undefined, limit: number, after?: {updatedAt:string;entityId:string}): Promise<RuntimeRecord[]>;
  scoped?(actorId: string, request: ScopedProgressRequest, signal?: AbortSignal): Promise<ScopedProgressView>;
  probe?(): Promise<void>;
}

export function openFirestoreProgressReader(config: AppConfig): ProgressSnapshotReader {
  if (config.storageDriver !== "firestore-records") throw new Error("Progress snapshots require normalized Firestore");
  const records = FirestoreRecordStore.create(config.storageEncryptionKey, {
    projectId: config.firestoreProjectId!, databaseId: config.firestoreDatabaseId!, workspaceId: config.firestoreWorkspaceId!,
  }, { ...(config.firestoreKeyFile ? { keyFilename: config.firestoreKeyFile } : {}), ...(config.firestoreKeyJson ? { credentials: config.firestoreKeyJson } : {}) }, config.firestoreContentFormat, true);
  const cancellation = new FirestoreChatCancellation(records, config);
  let closed = false, closing: Promise<void> | undefined;
  let lastImage: FirestoreRecordSnapshot | undefined, lastState: RepositoryState | undefined;
  const snapshots = new AsyncMutex();
  const images = new WeakMap<RepositoryState, FirestoreRecordSnapshot>();
  const responseState = (state: RepositoryState, image: FirestoreRecordSnapshot) => { const copy=structuredClone(state);images.set(copy,image);return copy; };
  const assertOpen = () => { if (closed) throw new Error("Progress reader is closed"); };
  const close = () => {
    closed = true;
    return closing ??= (async () => { try { await cancellation.close(); } finally { await records.close(); } })();
  };
  return Object.freeze({
    ...(config.firestoreContentFormat === "native-fields/v1" ? {
      scoped: (actorId:string, request:ScopedProgressRequest, signal?:AbortSignal) => {
        assertOpen();
        return boundedOperation(()=>records.readScoped(reader=>scopedProgressView(reader,actorId,request)), {
          timeoutMs:30_000,label:"Scoped Firestore progress",...(signal?{signal}:{}),
          onAbandon:()=>{void close().catch(()=>{});},onLateSettlement:()=>{void close().catch(()=>{});},
        });
      },
      probe:()=>{assertOpen();return boundedOperation(()=>records.readScoped(async()=>{}),{timeoutMs:30_000,label:"Committed Firestore head probe"});},
    } : {}),
    ...(config.firestoreContentFormat === "native-fields/v1" ? {metadataPage: (state:RepositoryState, kind:string, ownerId:string|undefined, limit:number, after?:{updatedAt:string;entityId:string}) => {
      assertOpen(); const image=images.get(state);if (!image) throw new Error("An authenticated image is required before querying");
      return records.metadataPage(image,kind,ownerId,limit,after);
    }} : {}),
    cancellationRequested(operation: ChatOperation, signal?: AbortSignal) { assertOpen(); return cancellation.requested(operation, signal); },
    snapshot(options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
      assertOpen();
      const timeoutMs = options.timeoutMs ?? 30_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Invalid progress snapshot deadline");
      return boundedOperation(() => snapshots.runExclusive(async () => {
        assertOpen();
        const image = await records.load(lastImage);
        assertOpen();
        // Reuse conversion only within this owned request. Always revalidate
        // the authenticated head; never use a TTL or stale permissions cache.
        if (image === lastImage && lastState) return responseState(lastState,image);
        const body = records.readRecords(image);
        // Missing/legacy state is never permission to seed defaults or admin.
        if (!body.length) throw new Error("No committed normalized progress image");
        const state = checkedFirestoreState(Buffer.from(JSON.stringify(assembleFirestoreState(body))));
        assertOpen(); lastImage = image; lastState = state; return responseState(state,image);
      }), { timeoutMs, label: "Firestore progress snapshot", signal: options.signal,
        onAbandon: () => { void close().catch(() => {}); }, onLateSettlement: () => { void close().catch(() => {}); } });
    },
    close,
  });
}
