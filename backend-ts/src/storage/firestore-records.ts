import { randomBytes } from "node:crypto";
import type { Settings } from "@google-cloud/firestore";
import { AsyncMutex } from "../repository/async-mutex.js";
import { restoreState, type PersistenceBackend, type RepositoryState } from "../repository/store.js";
import type { ExecutionCheckpoint } from "../repository/execution-transaction.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { checkpointRecords, recordKey, type RuntimeRecord } from "./execution-record-layout.js";
import { assembleFirestoreState, splitFirestoreState, firestoreExecutionRecordScope } from "./firestore-record-layout.js";
import { FirestoreRecordStore, type FirestoreRecordSnapshot } from "./firestore-record-store.js";
import type { FirestoreNamespace } from "./firestore-record-codec.js";
import { FIRESTORE_WRITER_BOUNDS, FirestoreOwnershipFailure, type FirestoreWriterClock } from "./firestore-writer-ownership.js";
import { assertFirestoreLegacyBackupHash, prepareFirestoreLegacyCutover } from "./firestore-legacy-cutover.js";

type Cached = { record: RuntimeRecord; json: string };
type Options = Pick<Settings, "keyFilename" | "credentials"> & {
  contentFormat?: "encrypted-records/v1" | "native-fields/v1";
  writerDuration?: number; clock?: FirestoreWriterClock; initializationTimeoutMs?: number; signal?: AbortSignal;
  reuseVerifiedImages?: boolean;
};
class FirestoreLegacyMigrationRequired extends Error {}
const cached = (record: RuntimeRecord): Cached => ({ record: structuredClone(record), json: canonicalJSONBytes(record).toString("utf8") });
export function checkedFirestoreState(payload: Uint8Array): RepositoryState {
  const decoded: unknown = JSON.parse(Buffer.from(payload).toString("utf8")), restored = restoreState(payload);
  // Normalized authority is not an implicit legacy migration or a catch-all
  // repair that silently replaces malformed authorization/domain records.
  // Pre-personal-token snapshots may omit this newly introduced empty map.
  // Adding it grants no token or role. Present/malformed maps and every other
  // normalization difference still require explicit repair; never overwrite
  // existing records or adopt the shared catalog credential here.
  const compatible = typeof decoded === "object" && decoded !== null && !Array.isArray(decoded) && !Object.hasOwn(decoded, "userMcpCredentials")
    ? { ...decoded, userMcpCredentials: {} } : decoded;
  if (!canonicalJSONBytes(compatible).equals(canonicalJSONBytes(restored))) throw new Error("Firestore state requires explicit schema repair or migration");
  return restored;
}

/** Normalized application adapter. Capability markers describe the implemented
 * acknowledged single-writer and atomic scoped checkpoint protocol, not config.
 * Uses one acknowledged writer, scoped deltas, and denial-only authority hooks.
 * Never calls models/ERP from storage transactions or automatically imports data. */
export class FirestoreRecordPersistence implements PersistenceBackend {
  readonly readQueueDurability = "encrypted-single-writer" as const;
  readonly executionCheckpointDurability = "encrypted-record-transactions/v1" as const;
  readonly #mutex = new AsyncMutex();
  readonly #records = new Map<string, Cached>();
  readonly #scopes = new Map<string, Set<string>>();
  readonly #observers = new Set<() => void>();
  #snapshot: FirestoreRecordSnapshot | null = null;
  #loaded = false;
  #uncertain = false;
  #unavailable = false;
  #denialNotified = false;
  #closed = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #renewal: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #unsubscribe: (() => void) | undefined;
  private constructor(readonly records: FirestoreRecordStore, readonly duration: number, readonly encryptionKey: string, readonly namespace: FirestoreNamespace) {}

  static async open(encryptionKey: string, namespace: FirestoreNamespace, options: Options = {}): Promise<FirestoreRecordPersistence> {
    const timeout = options.initializationTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new Error("Invalid Firestore initialization deadline");
    const adapter = new FirestoreRecordPersistence(FirestoreRecordStore.create(encryptionKey, namespace, options, options.contentFormat, options.reuseVerifiedImages), options.writerDuration ?? FIRESTORE_WRITER_BOUNDS.duration, encryptionKey, namespace);
    let rejectCancelled!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    const abort = () => {
      // Revoke synchronously, then drain the owned SDK even if acquisition
      // completes later. A timeout cannot publish a late controller.
      void adapter.close().catch(() => {});
      rejectCancelled(new Error("Firestore writer initialization was cancelled or timed out"));
    };
    const timer = setTimeout(abort, timeout); timer.unref();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (options.signal?.aborted) abort();
      await Promise.race([adapter.records.acquireWriter({ duration: adapter.duration, ...(options.clock ? { clock: options.clock } : {}) }), cancelled]);
      if (adapter.#closed) throw new Error("Firestore writer initialization was cancelled");
      adapter.#unsubscribe = adapter.records.observeWriterUnavailable(() => { adapter.#unavailable = true; adapter.deny(); });
      adapter.records.assertWriterActive(); adapter.scheduleRenewal(); return adapter;
    } catch (error) {
      // Confirmed contention is observed before a lease transition or repository opens.
      // It may be retried by a bounded host only after this SDK client drains.
      // Failed disposal removes that retry category; unknown ACKs never get it.
      let reason = error instanceof FirestoreOwnershipFailure ? error.reason : "UNCONFIRMED";
      if (reason === "WRITER_HELD" || reason === "WRITER_HANDOFF") {
        try { await adapter.close(); } catch { reason = "UNCONFIRMED"; }
      } else void adapter.close().catch(() => {});
      // Preserve only our bounded category, never raw SDK/credential errors.
      throw new Error("Firestore record storage could not establish confirmed exclusive writer authority", {
        cause: new FirestoreOwnershipFailure(reason),
      });
    } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
  }
  private deny(): void {
    if (this.#denialNotified) return; this.#denialNotified = true;
    for (const observer of this.#observers) { try { observer(); } catch { /* denial never grants authority */ } }
  }
  observeUnavailable(observer: () => void): () => void {
    this.#observers.add(observer);
    if (this.#closed || this.#unavailable || this.#uncertain) { try { observer(); } catch { /* denied */ } }
    return () => { this.#observers.delete(observer); };
  }
  private assertOwner(): void {
    if (this.#closed || this.#unavailable) throw new Error("Firestore writer authority is unavailable; dispatch is fenced");
  }
  assertAuthority(): void {
    this.assertOwner();
    if (!this.#loaded || this.#uncertain || !this.#snapshot) throw new Error("Firestore state must be authoritatively loaded; dispatch is fenced");
    this.records.assertWriterActive();
  }
  private scheduleRenewal(): void {
    clearTimeout(this.#timer);
    if (this.#closed || this.#unavailable) return;
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.renewOwnership().catch(() => {}); }, Math.floor(this.duration / 3));
    this.#timer.unref();
  }
  /** Trusted lifecycle method. Coalesces heartbeat/probe callers; only an
   * acknowledged underlying renewal can extend entry authority. */
  renewOwnership(): Promise<void> {
    if (this.#renewal) return this.#renewal;
    this.#renewal = (async () => {
      try { this.assertOwner(); await this.records.renewWriter(); this.assertOwner(); this.scheduleRenewal(); }
      catch (error) { this.#unavailable = true; clearTimeout(this.#timer); this.deny(); throw error; }
      finally { this.#renewal = undefined; }
    })();
    return this.#renewal;
  }
  private install(key: string, value: Cached): void {
    this.#records.set(key, value); const scope = firestoreExecutionRecordScope(value.record);
    if (scope !== null) { let keys = this.#scopes.get(scope); if (!keys) this.#scopes.set(scope, keys = new Set()); keys.add(key); }
  }
  private remove(key: string): void {
    const value = this.#records.get(key); if (!value) return;
    const scope = firestoreExecutionRecordScope(value.record);
    if (scope !== null) { const keys = this.#scopes.get(scope); keys?.delete(key); if (!keys?.size) this.#scopes.delete(scope); }
    this.#records.delete(key);
  }
  async load(): Promise<Uint8Array | null> {
    return this.#mutex.runExclusive(async () => {
      this.assertOwner();
      try {
        const snapshot = await this.records.load(), records = this.records.readRecords(snapshot);
        let payload: Buffer | null = null;
        if (!records.length) {
          if ((await this.records.db.doc("runtime/state").get()).exists) throw new FirestoreLegacyMigrationRequired("Legacy Firestore aggregate exists; explicit backed-up migration is required");
        } else payload = Buffer.from(JSON.stringify(checkedFirestoreState(Buffer.from(JSON.stringify(assembleFirestoreState(records))))));
        this.records.assertWriterActive(); this.assertOwner();
        const values = records.map(record => [recordKey(record.path), cached(record)] as const);
        this.#records.clear(); this.#scopes.clear(); for (const [key, value] of values) this.install(key, value);
        this.#snapshot = snapshot; this.#loaded = true; this.#uncertain = false; this.#denialNotified = false;
        return payload;
      } catch (error) {
        if (error instanceof FirestoreLegacyMigrationRequired) throw error;
        this.#uncertain = true; this.deny(); throw error;
      }
    });
  }
  /** Explicit bounded cutover only. The legacy aggregate is retained and the
   * normalized target must be empty. The caller must first retain an external
   * backup and provide its decompressed plaintext SHA-256. */
  async migrateLegacy(expectedSourceHash: string): Promise<Readonly<{ sourceHash: string; sourceBytes: number; recordCount: number; recordFingerprint: string }>> {
    return this.#mutex.runExclusive(async () => {
      this.assertOwner();
      if (!/^sha256:[a-f0-9]{64}$/.test(expectedSourceHash)) throw new Error("An explicit legacy Firestore backup hash is required");
      const row = await this.records.db.doc("runtime/state").get();
      if (!row.exists) throw new Error("Legacy Firestore source is unavailable");
      const prepared = prepareFirestoreLegacyCutover(row.data(), this.encryptionKey, this.namespace);
      assertFirestoreLegacyBackupHash(prepared.sourceHash, expectedSourceHash);
      let activated: FirestoreRecordSnapshot;
      try {
        const transitionId = `legacy_cutover_${expectedSourceHash.slice("sha256:".length)}`;
        activated = await this.records.initializeStaged(prepared.records, transitionId, { path: "runtime/state", document: row.data() });
        const authoritative = await this.records.load(), reloaded = this.records.readRecords(authoritative);
        if (authoritative.transitionIdentity !== activated.transitionIdentity || authoritative.fingerprint !== activated.fingerprint || authoritative.recordCount !== prepared.recordCount ||
            prepareFirestoreLegacyCutover(row.data(), this.encryptionKey, this.namespace).recordFingerprint !== prepared.recordFingerprint ||
            !canonicalJSONBytes(assembleFirestoreState(reloaded)).equals(canonicalJSONBytes(prepared.state)))
          throw new Error("Activated Firestore migration differs from the authenticated source");
        activated = authoritative;
      } catch (error) {
        if (this.records.writeUncertain) { this.#uncertain = true; this.deny(); }
        throw error;
      }
      this.records.assertWriterActive(); this.assertOwner();
      this.#records.clear(); this.#scopes.clear();
      for (const record of prepared.records) this.install(recordKey(record.path), cached(record));
      this.#snapshot = activated; this.#loaded = true; this.#uncertain = false; this.#denialNotified = false;
      return Object.freeze({ sourceHash: prepared.sourceHash, sourceBytes: prepared.sourceBytes, recordCount: prepared.recordCount, recordFingerprint: prepared.recordFingerprint });
    });
  }
  async save(payload: Uint8Array): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      this.assertAuthority();
      await this.commit(splitFirestoreState(checkedFirestoreState(payload)), new Set(this.#records.keys()));
    });
  }
  async saveExecutionCheckpoint(checkpoint: ExecutionCheckpoint): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      this.assertAuthority();
      if (!Number.isSafeInteger(checkpoint.auditStart) || checkpoint.auditStart < 0 || !Array.isArray(checkpoint.auditAppend) ||
          this.#records.get(recordKey(["auditLogs"]))?.record.value !== checkpoint.auditStart)
        throw new Error("Scoped audit append does not match committed Firestore history");
      await this.commit(checkpointRecords(checkpoint), new Set(this.#scopes.get(checkpoint.executionId) ?? []));
    });
  }
  private async commit(records: RuntimeRecord[], replaced: Set<string>): Promise<void> {
    const changed = new Map<string, Cached>(), seen = new Set<string>();
    for (const record of records) {
      const key = recordKey(record.path), value = cached(record);
      if (seen.has(key)) throw new Error("Duplicate Firestore application record"); seen.add(key); replaced.delete(key);
      if (this.#records.get(key)?.json !== value.json) changed.set(key, value);
    }
    try {
      if (!changed.size && !replaced.size) { await this.records.probeWriter(this.#snapshot!); this.assertAuthority(); return; }
      const snapshot = await this.records.commit(this.#snapshot!, { transitionId: `repository_${randomBytes(16).toString("hex")}`,
        upsert: [...changed.values()].map(value => value.record), remove: [...replaced].map(key => this.#records.get(key)!.record.path) });
      this.assertAuthority();
      for (const key of replaced) this.remove(key);
      for (const [key, value] of changed) { this.remove(key); this.install(key, value); }
      this.#snapshot = snapshot;
    } catch (error) { this.#uncertain = true; this.deny(); throw error; }
  }
  async probe(): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      this.assertAuthority();
      try { await this.records.probeWriter(this.#snapshot!); this.assertAuthority(); }
      catch (error) { this.#uncertain = true; this.deny(); throw error; }
    });
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true; this.#unavailable = true; clearTimeout(this.#timer); this.deny(); this.#unsubscribe?.();
    this.#closing = this.records.close(); return this.#closing;
  }
}
