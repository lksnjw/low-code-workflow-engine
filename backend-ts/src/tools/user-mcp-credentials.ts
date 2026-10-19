import { allRolesToolAccess } from "../governance/tool-access.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import type { AppConfig, ErpbridgeConnectionConfig } from "../config/config.js";
import type { Repository, RepositoryState } from "../repository/store.js";
import { AESGCMCodec } from "../storage/aes-gcm.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { HandlerFailure } from "../http/handlers/common.js";
import { createBridgeProtocolAdapter } from "./erpbridge-protocol-adapter.js";
import type { DispatchIdentity } from "./registry.js";

const cid = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const recordSchema = z.object({ profile: z.literal("user-mcp-credential/v1"), actorId: z.string().min(1), connectionId: cid,
  revision: z.number().int().positive(), enabled: z.boolean(), ciphertext: z.string().optional(), updatedAt: z.string().datetime(),
  testedAt: z.string().datetime().optional() }).strict();
export const userCredentialCommand = z.object({ baseRevision: z.number().int().nonnegative(), token: z.string().min(8).max(16384)
  .refine(t => t === t.trim() && !/[\s\x00-\x1f\x7f]/.test(t), "Enter only the bearer token, without spaces or JSON") }).strict();
export const userCredentialRevisionCommand = z.object({ baseRevision: z.number().int().nonnegative() }).strict();
export type UserCredentialBinding = { profile: "user-mcp-binding/v1"; actorId: string; revisions: Record<string, number>; environmentSecret?: Record<string, string> | undefined };
const bindingSchema = z.object({ profile: z.literal("user-mcp-binding/v1"), actorId: z.string().min(1),
  revisions: z.record(cid, z.number().int().nonnegative()), environmentSecret: z.record(cid, z.string().regex(/^[a-f0-9]{64}$/)).optional() }).strict();
const hash = (value: unknown) => createHash("sha256").update(canonicalJSONBytes(value)).digest("hex");
const key = (actorId: string, connectionId: string) => hash(["user-mcp", actorId, connectionId]);
const fail = (message: string, code = "ERP_USER_CREDENTIAL_REQUIRED", status = 409): never => { throw new HandlerFailure(status, message, { code }); };
type Context = { actorId: string; expected?: UserCredentialBinding };
type AdapterFactory = typeof createBridgeProtocolAdapter;
type SelectedCredential = { source: "personal"; record: z.infer<typeof recordSchema> } | { source: "administrator-environment"; fingerprint: string };

/** Business SDK entry uses an immutable actor-bound credential receipt. Only
 * an explicit server opt-in permits the built-in admin to use the environment
 * credential; every other role needs its own token. This grants no tool rights. */
export class UserMcpCredentials {
  readonly #context = new AsyncLocalStorage<Context>();
  readonly #codec: AESGCMCodec;
  readonly #connections: Map<string, ErpbridgeConnectionConfig>;
  readonly #unobserve: () => void;
  readonly #environmentTests = new Map<string, string>();
  #state: Readonly<RepositoryState> | undefined;
  #closed = false;
  constructor(readonly repository: Repository, readonly config: AppConfig, readonly factory: AdapterFactory = createBridgeProtocolAdapter) {
    this.#codec = new AESGCMCodec(config.storageEncryptionKey);
    this.#connections = new Map(config.erpbridgeConnections.map(c => [c.id, c]));
    this.#unobserve = repository.observeCommits({ committed: state => { this.#state = state; }, unavailable: () => { this.#state = undefined; } });
  }
  close() { this.#closed = true; this.#state = undefined; this.#environmentTests.clear(); this.#unobserve(); }
  private connection(id: string) {
    const connection = this.#connections.get(id);
    if (!connection || !cid.safeParse(id).success) fail("Unknown configured ERP connection", "ERP_CONNECTION_UNKNOWN", 404);
    return connection!;
  }
  private actor(state: Readonly<RepositoryState>, id: string) {
    // Admission may receive a scoped transaction's recursive read-only view.
    // Read only these authority scalars; structuredClone cannot clone proxies,
    // and unwrapping the view would bypass its unrelated-write protection.
    const actor = state.users[id], role = actor ? state.roles[actor.roleId] : undefined;
    if (!actor || actor.id !== id || typeof actor.status !== "string" || actor.status.toLowerCase() !== "active" || !role || typeof role.name !== "string" || !role.name)
      fail("ERP credential owner is not active", "ERP_ACTOR_UNAVAILABLE", 403);
    return { id, status: actor!.status, role: role!.name, roleId: actor!.roleId };
  }
  private environmentAdmin(actor: ReturnType<UserMcpCredentials["actor"]>) {
    return this.config.erpbridgeAdminEnvironmentAccess === true && (allRolesToolAccess() || actor.roleId === "role_admin" && actor.role === "Platform Admin");
  }
  private environmentFingerprint(actorId: string, id: string) {
    const connection = this.connection(id);
    return createHmac("sha256", this.config.storageEncryptionKey).update(canonicalJSONBytes(
      ["admin-environment-mcp/v1", actorId, id, connection.baseURL, connection.mcpToken, connection.roleMap])).digest("hex");
  }
  private record(state: Readonly<RepositoryState>, actorId: string, id: string) {
    const raw = state.userMcpCredentials[key(actorId, id)];
    if (raw === undefined) return undefined;
    const record = recordSchema.parse(raw);
    if (record.actorId !== actorId || record.connectionId !== id || record.enabled !== Boolean(record.ciphertext)) fail("ERP credential storage requires repair", "ERP_CREDENTIAL_INVALID", 503);
    return record;
  }
  binding(state: Readonly<RepositoryState>, actorId: string): UserCredentialBinding {
    const actor = this.actor(state, actorId);
    return { profile: "user-mcp-binding/v1", actorId, revisions: Object.fromEntries([...this.#connections.keys()].map(id => [id, this.record(state, actorId, id)?.revision ?? 0])),
      ...(this.environmentAdmin(actor) ? { environmentSecret: Object.fromEntries([...this.#connections.keys()].map(id => [id, this.environmentFingerprint(actorId, id)])) } : {}) };
  }
  async scope<T>(actorId: string, expected: unknown, action: () => Promise<T>): Promise<T> {
    // Undefined receipt is deliberately not upgraded to today's token for old
    // queued work. Metadata/conversation may continue, business dispatch fails.
    const parsed = bindingSchema.safeParse(expected);
    return this.#context.run({ actorId, ...(parsed.success && parsed.data.actorId === actorId ? { expected: parsed.data } : {}) }, action);
  }
  async requestScope<T>(actorId: string, action: () => Promise<T>): Promise<T> {
    const expected = await this.repository.readAuthoritative(state => this.binding(state, actorId));
    return this.scope(actorId, expected, action);
  }
  private checked(state: Readonly<RepositoryState>, actorId: string, id: string, expected: UserCredentialBinding, localRole?: string): SelectedCredential {
    if (this.#closed) fail("ERP credential service is stopped", "ERP_CREDENTIAL_UNAVAILABLE", 503);
    const actor = this.actor(state, actorId), record = this.record(state, actorId, id);
    if (expected.actorId !== actorId || !Object.hasOwn(expected.revisions, id) || expected.revisions[id] !== (record?.revision ?? 0))
      fail("Your ERP token changed. Review and start a new request; the old operation was not rebound.", "ERP_USER_CREDENTIAL_CHANGED");
    if (localRole !== undefined && actor.role !== localRole) fail("ERP requester role changed", "ERP_ACTOR_UNAVAILABLE", 403);
    const environment = this.environmentAdmin(actor), fingerprint = expected.environmentSecret?.[id];
    if (environment) {
      const current = this.environmentFingerprint(actorId, id);
      if (fingerprint !== current) fail("Administrator ERP credential binding changed. Start a new reviewed request; old work was not rebound.", "ERP_USER_CREDENTIAL_CHANGED");
      return { source: "administrator-environment", fingerprint: current };
    }
    if (fingerprint !== undefined) fail("Administrator ERP access changed. Start a new reviewed request.", "ERP_USER_CREDENTIAL_CHANGED");
    if (!record?.enabled || !record.ciphertext) fail("Add your own ERPBridge token in Profile → ERP connections before using ERP tools.");
    return { source: "personal", record: record! };
  }
  private selectedToken(selected: SelectedCredential, connection: ErpbridgeConnectionConfig) {
    return selected.source === "administrator-environment" ? connection.mcpToken : this.decode(selected.record);
  }
  private decode(record: z.infer<typeof recordSchema>): string {
    try {
      const data = JSON.parse(this.#codec.decode(Buffer.from(record.ciphertext!, "base64")).toString("utf8"));
      if (data.actorId !== record.actorId || data.connectionId !== record.connectionId || data.revision !== record.revision || !userCredentialCommand.shape.token.safeParse(data.token).success) throw new Error();
      return data.token;
    } catch { return fail("ERP credential cannot be decrypted", "ERP_CREDENTIAL_INVALID", 503); }
  }
  async prepare(identity: DispatchIdentity, id: string) {
    const connection = this.connection(id), scope = this.#context.getStore();
    if (!scope?.expected || scope.actorId !== identity.userId) fail("ERP execution has no original user credential binding", "ERP_USER_BINDING_REQUIRED");
    const expected = scope!.expected!;
    const selected = await this.repository.readAuthoritative(state => {
      this.#state = state; return structuredClone(this.checked(state, identity.userId, id, expected, identity.localRole));
    });
    const sdk = this.factory({ baseURL: connection.baseURL, token: this.selectedToken(selected, connection), timeoutMs: this.config.mcpTimeoutMs });
    const assertCurrent = () => {
      this.repository.assertAuthority();
      if (!this.#state) fail("ERP credential authority is unavailable", "ERP_CREDENTIAL_UNAVAILABLE", 503);
      this.checked(this.#state!, identity.userId, id, expected, identity.localRole);
    };
    try { await sdk.connect(); assertCurrent(); }
    catch (cause) {
      await sdk.close().catch(() => {});
      if (cause instanceof HandlerFailure) throw cause;
      fail("Your ERPBridge token could not connect. Check its validity and permissions.", "ERP_USER_CONNECTION_FAILED", 502);
    }
    return { sdk, assertCurrent, close: () => sdk.close() };
  }
  async list(actorId: string) {
    return this.repository.readAuthoritative(state => {
      const environment = this.environmentAdmin(this.actor(state, actorId));
      return { credentialMode: environment ? "administrator-environment" : "per-user", catalogSource: "administrator-environment", connections: [...this.#connections.values()].map(c => {
        const record = this.record(state, actorId, c.id);
        return { id: c.id, primary: c.primary, endpoint: new URL("/mcp/", c.baseURL).href, revision: record?.revision ?? 0,
          source: environment ? "administrator-environment" : record?.enabled ? "personal" : "missing",
          configured: environment || (record?.enabled ?? false), updatedAt: environment ? null : record?.updatedAt ?? null,
          testedAt: environment ? this.#environmentTests.get(this.environmentFingerprint(actorId, c.id)) ?? null : record?.testedAt ?? null };
      }) };
    });
  }
  async save(actorId: string, id: string, raw: unknown) {
    this.connection(id);
    const parsed = userCredentialCommand.safeParse(raw);
    if (!parsed.success) fail("Enter a valid bearer token and current revision", "ERP_CREDENTIAL_INPUT_INVALID", 400);
    const body = parsed.data!;
    await this.repository.mutate(state => {
      if (this.environmentAdmin(this.actor(state, actorId))) fail("Administrator ERP credentials are managed in server environment/secret configuration", "ERP_ADMIN_ENVIRONMENT_MANAGED", 403);
      const prior = this.record(state, actorId, id);
      if ((prior?.revision ?? 0) !== body.baseRevision) fail("ERP connection changed; reload before replacing it", "ERP_USER_CREDENTIAL_CHANGED");
      const revision = body.baseRevision + 1;
      state.userMcpCredentials[key(actorId, id)] = { profile: "user-mcp-credential/v1", actorId, connectionId: id, revision, enabled: true,
        ciphertext: this.#codec.encode(Buffer.from(JSON.stringify({ actorId, connectionId: id, revision, token: body.token }))).toString("base64"), updatedAt: new Date().toISOString() };
      state.auditLogs.push({ id: `user-erp-${key(actorId, id)}-${revision}`, actor: { id: actorId }, action: "erp.credential.replaced", resource: { type: "user-erp-connection", id }, revision, createdAt: new Date().toISOString() });
    });
    return this.list(actorId);
  }
  async remove(actorId: string, id: string, raw: unknown) {
    this.connection(id); const parsed = userCredentialRevisionCommand.safeParse(raw);
    if (!parsed.success) fail("Current ERP connection revision required", "ERP_CREDENTIAL_INPUT_INVALID", 400);
    await this.repository.mutate(state => {
      if (this.environmentAdmin(this.actor(state, actorId))) fail("Administrator ERP credentials are managed in server environment/secret configuration", "ERP_ADMIN_ENVIRONMENT_MANAGED", 403);
      const prior = this.record(state, actorId, id);
      if ((prior?.revision ?? 0) !== parsed.data!.baseRevision) fail("ERP connection changed; reload before removing it", "ERP_USER_CREDENTIAL_CHANGED");
      const revision = parsed.data!.baseRevision + 1;
      state.userMcpCredentials[key(actorId, id)] = { profile: "user-mcp-credential/v1", actorId, connectionId: id, revision, enabled: false, updatedAt: new Date().toISOString() };
      state.auditLogs.push({ id: `user-erp-${key(actorId, id)}-${revision}`, actor: { id: actorId }, action: "erp.credential.removed", resource: { type: "user-erp-connection", id }, revision, createdAt: new Date().toISOString() });
    });
    return this.list(actorId);
  }
  async test(actorId: string, id: string, raw: unknown) {
    const connection = this.connection(id), parsed = userCredentialRevisionCommand.safeParse(raw);
    if (!parsed.success) fail("Current ERP connection revision required", "ERP_CREDENTIAL_INPUT_INVALID", 400);
    let expected!: UserCredentialBinding;
    const selected = await this.repository.readAuthoritative(state => {
      expected = this.binding(state, actorId);
      if (expected.revisions[id] !== parsed.data!.baseRevision) fail("ERP connection changed; reload before testing", "ERP_USER_CREDENTIAL_CHANGED");
      return structuredClone(this.checked(state, actorId, id, expected));
    });
    const sdk = this.factory({ baseURL: connection.baseURL, token: this.selectedToken(selected, connection), timeoutMs: this.config.mcpTimeoutMs });
    try { await sdk.connect(); await sdk.listTools(); }
    catch { fail("ERPBridge connection test failed. Check your token; no ERP business operation was requested.", "ERP_USER_CONNECTION_FAILED", 502); }
    finally { await sdk.close().catch(() => {}); }
    if (selected.source === "administrator-environment") {
      await this.repository.readAuthoritative(state => this.checked(state, actorId, id, expected));
      this.#environmentTests.set(selected.fingerprint, new Date().toISOString());
    } else await this.repository.mutate(state => {
      const checked = this.checked(state, actorId, id, expected);
      const current = this.record(state, actorId, id);
      if (checked.source !== "personal" || !current?.enabled || current.revision !== selected.record.revision) fail("ERP credential changed during test", "ERP_USER_CREDENTIAL_CHANGED");
      state.userMcpCredentials[key(actorId, id)] = { ...current!, testedAt: new Date().toISOString() };
    });
    return { ...(await this.list(actorId)), message: "Token connected and discovery completed. Each tool call still checks role, contract, policy and ERP authorization. No business tool was called." };
  }
}

type UserServices = { repository: Repository; userMcpCredentials?: UserMcpCredentials };
export function captureUserMcpBinding(services: UserServices, state: Readonly<RepositoryState>, actorId: string) {
  return services.userMcpCredentials?.binding(state, actorId);
}
export async function withUserMcpBinding<T>(services: UserServices, actorId: string, binding: unknown, action: () => Promise<T>): Promise<T> {
  return services.userMcpCredentials ? services.userMcpCredentials.scope(actorId, binding, action) : action();
}
