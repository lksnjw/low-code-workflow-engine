import { Firestore } from "@google-cloud/firestore";
import { gunzipSync, gzipSync } from "node:zlib";
import { AsyncMutex } from "../repository/async-mutex.js";
import type { PersistenceBackend } from "../repository/store.js";
import { AESGCMCodec } from "./aes-gcm.js";

const COLLECTION = "runtime";
const DOC_ID = "state";
const FIELD = "payload";
const GZIP_COMPRESSION = "gzip";

export type FirestoreConfig = {
  projectId: string;
  keyFilename?: string;
  credentials?: Record<string, unknown>;
  encryptionKey?: string;
};

export class FirestorePersistence implements PersistenceBackend {
  readonly #db: Firestore;
  readonly #mutex = new AsyncMutex();
  readonly #codec: AESGCMCodec | null;
  #closed = false;
  // Per-collection cache of last-mirrored entity JSON, used to skip writing
  // entities that haven't changed since the previous save(). In-memory only —
  // a fresh process re-mirrors everything once on its first save, same as before.
  readonly #lastMirrored = new Map<string, Map<string, string>>();

  private constructor(db: Firestore, codec: AESGCMCodec | null) {
    this.#db = db;
    this.#codec = codec;
  }

  static async open(config: FirestoreConfig): Promise<FirestorePersistence> {
    const db = new Firestore({
      projectId: config.projectId,
      ...(config.keyFilename ? { keyFilename: config.keyFilename } : {}),
      ...(config.credentials ? { credentials: config.credentials } : {}),
    });
    const codec = config.encryptionKey ? new AESGCMCodec(config.encryptionKey) : null;
    const instance = new FirestorePersistence(db, codec);
    await instance.probe();
    return instance;
  }

  async load(): Promise<Uint8Array | null> {
    return this.#mutex.runExclusive(async () => {
      this.assertOpen();
      const snap = await this.#db.collection(COLLECTION).doc(DOC_ID).get();
      if (!snap.exists) return null;
      const encoded = snap.get(FIELD) as string | undefined;
      if (!encoded) return null;
      const raw = Buffer.from(encoded, "base64");
      let decoded: Uint8Array = raw;
      if (this.#codec !== null) {
        try {
          decoded = this.#codec.decode(raw);
        } catch {
          // Legacy unencrypted blob — pass through; next save will encrypt it
          decoded = raw;
        }
      }
      return snap.get("compression") === GZIP_COMPRESSION
        ? decompressFirestorePayload(decoded)
        : decoded;
    });
  }

  async save(payload: Uint8Array): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      this.assertOpen();
      // The repository is serialized as one JSON value. Compress before optional
      // encryption so repeated registry and chat data do not exhaust Firestore's
      // 1 MiB per-document limit. Existing uncompressed documents remain readable
      // and are migrated on the next successful save.
      const compressed = compressFirestorePayload(payload);
      const data = this.#codec ? this.#codec.encode(compressed) : compressed;
      const encoded = data.toString("base64");
      await this.#db.collection(COLLECTION).doc(DOC_ID).set({
        [FIELD]: encoded,
        updatedAt: new Date().toISOString(),
        encrypted: this.#codec !== null,
        compression: GZIP_COMPRESSION,
      });
    });
    // Mirror human-readable collections in parallel — fire-and-forget.
    // Failure here never blocks the app; the blob above is authoritative.
    void this.#mirrorEntities(payload);
  }

  async #mirrorEntities(payload: Uint8Array): Promise<void> {
    try {
      const state = JSON.parse(Buffer.from(payload).toString("utf8")) as Record<string, unknown>;

      // Collections to mirror as individual Firestore documents.
      // Users are included but password hashes are kept in the blob only.
      const entityCollections: Record<string, Record<string, unknown>> = {
        workflows:     asEntityMap(state.workflows),
        executions:    asEntityMap(state.executions),
        notifications: asEntityMap(state.notifications),
        healing:       asEntityMap(state.healing),
        chats:         redactChats(state.chats),
        users:         redactUsers(state.users),
      };

      for (const [collName, entities] of Object.entries(entityCollections)) {
        // Diff against what was last mirrored so an unrelated field changing
        // elsewhere in the blob doesn't re-write every entity in every
        // collection on every save — that burns through Firestore's daily
        // write quota in minutes once there's any real amount of data.
        const previous = this.#lastMirrored.get(collName) ?? new Map<string, string>();
        const next = new Map<string, string>();
        const toWrite: Array<{ id: string; doc: Record<string, unknown> }> = [];
        for (const [id, doc] of Object.entries(entities)) {
          if (doc === null || typeof doc !== "object") continue;
          const json = JSON.stringify(doc);
          next.set(id, json);
          if (previous.get(id) !== json) toWrite.push({ id, doc: doc as Record<string, unknown> });
        }
        const removedIds = [...previous.keys()].filter((id) => !next.has(id));
        this.#lastMirrored.set(collName, next);
        if (toWrite.length === 0 && removedIds.length === 0) continue;

        // Firestore batch limit is 500 ops; chunk to stay safe.
        for (let i = 0; i < toWrite.length; i += 400) {
          const batch = this.#db.batch();
          for (const { id, doc } of toWrite.slice(i, i + 400))
            batch.set(this.#db.collection(collName).doc(id), doc, { merge: true });
          await batch.commit();
        }
        for (let i = 0; i < removedIds.length; i += 400) {
          const batch = this.#db.batch();
          for (const id of removedIds.slice(i, i + 400))
            batch.delete(this.#db.collection(collName).doc(id));
          await batch.commit();
        }
      }
    } catch {
      // Mirror errors are silently swallowed — the encrypted blob is still intact.
    }
  }

  async probe(): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      this.assertOpen();
      await this.#db.collection(COLLECTION).limit(1).get();
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#db.terminate();
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("Firestore state store is closed");
  }
}

export function compressFirestorePayload(payload: Uint8Array): Buffer {
  return gzipSync(payload);
}

export function decompressFirestorePayload(payload: Uint8Array): Buffer {
  return gunzipSync(payload);
}

function asEntityMap(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function redactUsers(value: unknown): Record<string, unknown> {
  const map = asEntityMap(value);
  const result: Record<string, unknown> = {};
  for (const [id, user] of Object.entries(map)) {
    if (typeof user !== "object" || user === null) continue;
    const { ...safe } = user as Record<string, unknown>;
    delete safe.passwordHash;
    result[id] = safe;
  }
  return result;
}

function redactChats(value: unknown): Record<string, unknown> {
  const map = asEntityMap(value);
  const result: Record<string, unknown> = {};
  for (const [id, chat] of Object.entries(map)) {
    if (typeof chat !== "object" || chat === null) continue;
    const { messages: _messages, ...meta } = chat as Record<string, unknown>;
    // Store only metadata — skip messages array to avoid exceeding 1 MiB doc limit.
    result[id] = { ...meta, messageCount: Array.isArray(_messages) ? _messages.length : 0 };
  }
  return result;
}
