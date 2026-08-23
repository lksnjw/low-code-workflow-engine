import { Pool, type PoolClient } from "pg";
import { AsyncMutex } from "../repository/async-mutex.js";
import type { PersistenceBackend } from "../repository/store.js";
import { AESGCMCodec } from "./aes-gcm.js";

const writerLockID = 1_279_477_061;

export class PostgresPersistence implements PersistenceBackend {
  readonly #mutex = new AsyncMutex();
  #closed = false;

  private constructor(readonly pool: Pool, readonly client: PoolClient, readonly codec: AESGCMCodec) {}

  static async open(databaseURL: string, encryptionKey: string): Promise<PostgresPersistence> {
    let pool: Pool;
    try { pool = new Pool({ connectionString: databaseURL, max: 4 }); }
    catch { throw new Error("DATABASE_URL could not be parsed"); }
    let client: PoolClient | null = null;
    try {
      client = await pool.connect();
      await client.query("SELECT 1");
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [writerLockID]);
      await client.query("CREATE TABLE IF NOT EXISTS runtime_state (state_key TEXT PRIMARY KEY, payload BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
      await client.query("COMMIT");
      const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [writerLockID]);
      if (lock.rows[0]?.locked !== true) throw new Error("another backend writer already owns the runtime state");
      return new PostgresPersistence(pool, client, new AESGCMCodec(encryptionKey));
    } catch (error) {
      if (client !== null) { try { await client.query("ROLLBACK"); } catch { /* connection may already be closed */ } client.release(); }
      await pool.end();
      const message = error instanceof Error ? error.message : "unknown PostgreSQL initialization error";
      throw new Error(`open PostgreSQL state store: ${message}`);
    }
  }

  async load(): Promise<Uint8Array | null> {
    return this.#mutex.runExclusive(async () => {
      this.assertOpen();
      const result = await this.client.query<{ payload: Buffer }>("SELECT payload FROM runtime_state WHERE state_key = $1", ["default"]);
      const payload = result.rows[0]?.payload;
      return payload === undefined ? null : this.codec.decode(payload);
    });
  }

  async save(payload: Uint8Array): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      this.assertOpen();
      const encrypted = this.codec.encode(payload);
      await this.client.query("INSERT INTO runtime_state(state_key,payload,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(state_key) DO UPDATE SET payload=EXCLUDED.payload, updated_at=NOW()", ["default", encrypted]);
    });
  }

  async probe(): Promise<void> {
    await this.#mutex.runExclusive(async () => { this.assertOpen(); await this.client.query("SELECT 1"); });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { await this.client.query("SELECT pg_advisory_unlock($1)", [writerLockID]); }
    finally { this.client.release(); await this.pool.end(); }
  }

  private assertOpen(): void { if (this.#closed) throw new Error("PostgreSQL state store is closed"); }
}

