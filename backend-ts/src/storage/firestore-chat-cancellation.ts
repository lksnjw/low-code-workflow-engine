import { performance } from "node:perf_hooks";
import type { AppConfig } from "../config/config.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { boundedOperation, OperationDeadlineExceeded } from "../core/bounded-operation.js";
import { authorizeChatOperation, publicChatOperation } from "../agent/chat-progress.js";
import { assertChatCancellationIntent, chatCancellationIntent, chatCancellationRecordSchema } from "../agent/chat-cancellation.js";
import type { ChatOperation, RepositoryState } from "../repository/store.js";
import type { CurrentUser } from "../http/handlers/common.js";
import { FirestoreRecordCodec } from "./firestore-record-codec.js";
import { FirestoreRecordStore, type FirestoreRecordSnapshot } from "./firestore-record-store.js";
import { assembleFirestoreState } from "./firestore-record-layout.js";
import { checkedFirestoreState } from "./firestore-records.js";
import { FirestoreChatStopReader } from "./firestore-chat-stop-reader.js";

export interface ChatCancellationControl {
  snapshot(signal?: AbortSignal): Promise<RepositoryState>;
  request(state: RepositoryState, user: CurrentUser, id: string, signal?: AbortSignal): Promise<ReturnType<typeof publicChatOperation>>;
  requested(operation: ChatOperation, signal?: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}

const OPERATION_MS = 10_000, CLOSE_MS = 1_000;
const abandoned = () => new DOMException("Chat control operation abandoned; remote outcome may be unknown", "AbortError");
const cleanupUnconfirmed = () => new Error("Chat cancellation control cleanup unconfirmed");

/** A separate encrypted stop-only mailbox. Never modifies the normalized head,
 * lease, application records, task claim or an execution permission. */
export class FirestoreChatCancellation implements ChatCancellationControl {
  readonly #codec: FirestoreRecordCodec;
  readonly #images = new WeakMap<RepositoryState, FirestoreRecordSnapshot>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #abort = new AbortController();
  #closed = false; #closing: Promise<void> | undefined;
  #reader: FirestoreChatStopReader | undefined;
  constructor(readonly records: FirestoreRecordStore, private readonly config: AppConfig, readonly ownsRecords = false) {
    if (config.storageDriver !== "firestore-records") throw new Error("Chat cancellation requires normalized Firestore");
    this.#codec = new FirestoreRecordCodec(config.storageEncryptionKey, { projectId: config.firestoreProjectId!,
      databaseId: config.firestoreDatabaseId!, workspaceId: config.firestoreWorkspaceId! });
    if (!canonicalJSONBytes(records.namespace).equals(canonicalJSONBytes(this.#codec.namespace)))
      throw new Error("Chat control namespace differs from storage");
  }
  private assertOpen() { if (this.#closed) throw new Error("Chat cancellation control is closed"); }
  private fence() { this.#closed = true; this.#abort.abort(); }
  private signal(signal?: AbortSignal) { return signal ? AbortSignal.any([signal, this.#abort.signal]) : this.#abort.signal; }
  private track<T>(work: (checkActive: () => void) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.assertOpen();
    if (signal?.aborted) return Promise.reject(new DOMException("Chat control request cancelled before entry", "AbortError"));
    const deadline = performance.now() + OPERATION_MS;
    let locallyAbandoned = false;
    const checkActive = () => {
      if (this.#closed || signal?.aborted || locallyAbandoned) throw abandoned();
      // The timer may not have run yet when an awaited SDK continuation resumes.
      if (performance.now() >= deadline) {
        locallyAbandoned = true; this.fence();
        throw new OperationDeadlineExceeded("Chat cancellation storage", OPERATION_MS);
      }
    };
    const pending = Promise.resolve().then(() => {
      checkActive(); return work(checkActive);
    });
    this.#pending.add(pending); void pending.finally(() => this.#pending.delete(pending)).catch(() => {});
    return boundedOperation(() => pending, { timeoutMs: OPERATION_MS, label: "Chat cancellation storage", signal: this.signal(signal),
      onAbandon: () => { locallyAbandoned = true; this.fence(); } });
  }
  snapshot(signal?: AbortSignal) {
    return this.track(async checkActive => {
      const image = await this.records.load(); checkActive();
      const body = this.records.readRecords(image);
      if (!body.length) throw new Error("No committed chat control authority image");
      const state = checkedFirestoreState(Buffer.from(JSON.stringify(assembleFirestoreState(body))));
      checkActive(); this.#images.set(state, image); return state;
    }, signal);
  }
  private reference(operation: ChatOperation) {
    const intent = chatCancellationIntent(operation);
    return this.records.db.doc(`workspaces/${this.#codec.namespace.workspaceId}/lcwe_chat_stop_intents/${this.#codec.identity("chat-stop-intent/v1", intent)}`);
  }
  request(state: RepositoryState, user: CurrentUser, id: string, signal?: AbortSignal) {
    return this.track(async checkActive => {
      const image = this.#images.get(state); if (!image) throw new Error("Chat control requires its own coherent authority image");
      const operation = authorizeChatOperation(state, state.chatOperations[id], user);
      const active = ["QUEUED", "RUNNING"].includes(operation.status);
      const intent = active ? chatCancellationIntent(operation) : undefined;
      const packet = intent ? this.#codec.encodeHead({ profile: "chat-cancellation-record/v1", intent, requestedAt: new Date().toISOString() }) : undefined;
      checkActive();
      await this.records.db.runTransaction(async transaction => {
        checkActive();
        // A concurrent worker/account mutation forces a fresh authenticated
        // image, not a stale permission decision or a business retry.
        await this.records.assertCommittedSnapshot(transaction, image);
        checkActive();
        if (!intent) return;
        const ref = this.reference(operation), previous = await transaction.get(ref);
        checkActive();
        if (previous.exists) {
          const saved = assertChatCancellationIntent(operation, chatCancellationRecordSchema.parse(this.#codec.decodeHead(previous.data())).intent);
          if (!canonicalJSONBytes(saved).equals(canonicalJSONBytes(intent))) throw new Error("Original stop intent differs");
        } else {
          checkActive();
          transaction.set(ref, packet!);
        }
      }, { maxAttempts: 3 });
      checkActive();
      return { ...publicChatOperation(operation), cancellationRequested: operation.cancellationRequested === true || active };
    }, signal);
  }
  requested(operation: ChatOperation, signal?: AbortSignal) {
    this.assertOpen();
    if (signal?.aborted) return Promise.reject(new DOMException("Chat control request cancelled before entry", "AbortError"));
    return (this.#reader ??= new FirestoreChatStopReader(this.config, this.#codec)).requested(operation, this.signal(signal));
  }
  close(): Promise<void> {
    this.fence();
    if (this.#closing) return this.#closing;
    const start = (close: () => Promise<void> | undefined) => {
      try { return Promise.resolve(close()); } catch (error) { return Promise.reject(error); }
    };
    // Start owned transport cleanup before waiting for raw work. A borrowed
    // store remains its owner's responsibility; guards do not cancel its RPCs.
    const reader = start(() => this.#reader?.close());
    const records = start(() => this.ownsRecords ? this.records.close() : undefined);
    const cleanup = Promise.all([Promise.allSettled([...this.#pending]), reader, records]);
    this.#closing = boundedOperation(async () => { await cleanup; }, { timeoutMs: CLOSE_MS, label: "Chat cancellation cleanup" })
      .catch(() => { throw cleanupUnconfirmed(); });
    return this.#closing;
  }
}
export function openFirestoreChatCancellation(config: AppConfig): ChatCancellationControl {
  const records = FirestoreRecordStore.create(config.storageEncryptionKey, { projectId: config.firestoreProjectId!,
    databaseId: config.firestoreDatabaseId!, workspaceId: config.firestoreWorkspaceId! }, {
    ...(config.firestoreKeyFile ? { keyFilename: config.firestoreKeyFile } : {}), ...(config.firestoreKeyJson ? { credentials: config.firestoreKeyJson } : {}),
  }, config.firestoreContentFormat);
  return new FirestoreChatCancellation(records, config, true);
}
