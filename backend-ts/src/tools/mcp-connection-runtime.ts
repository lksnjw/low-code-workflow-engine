import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { boundedOperation, OperationDeadlineExceeded } from "../core/bounded-operation.js";
import type { AppConfig, ErpbridgeConnectionConfig } from "../config/config.js";
import type { Repository, RepositoryState } from "../repository/store.js";
import type { RegistryService } from "../registry/service.js";
import type { RegistryValidator } from "../validator/registry-validator.js";
import { admissionAuthorizer, DEFAULT_BRIDGE_CONNECTION } from "../registry/capability-admission.js";
import { assertActorAuthority } from "../http/handlers/model-selection.js";
import { appendAudit, HandlerFailure, nextID, now, type CurrentUser } from "../http/handlers/common.js";
import { createErpbridgeMcpSession, type ErpbridgeMcpSession } from "./erpbridge-mcp-client.js";
import type { FastifyRequest } from "fastify";
import { bindExecutionHost } from "../runner/execution-host.js";

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const connectionId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const recordSchema = z.object({ id: connectionId, revision: z.number().int().positive(), desiredEnabled: z.boolean(), configurationHash: hash, updatedAt: z.string().datetime() }).strict();
const operationSchema = z.object({ id: z.string(), actorId: z.string(), action: z.enum(["connect", "disconnect", "test"]), scope: hash, requestHash: hash,
  connectionId: connectionId.optional(),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  revision: z.number().int().positive(), state: z.enum(["RUNNING", "DONE", "FAILED", "INTERRUPTED"]), startedAt: z.string().datetime(), completedAt: z.string().datetime().optional(),
  reason: z.enum(["MCP_OPERATION_FAILED", "MCP_WAIT_TIMEOUT", "MCP_OPERATION_INTERRUPTED", "MCP_ACTOR_REVOKED", "MCP_STORAGE_UNCERTAIN"]).optional(), discoveryCount: z.number().int().nonnegative().optional() }).strict();
export const connectionCommandSchema = z.object({ baseRevision: z.number().int().positive(), requestId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) }).strict();
const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJSONBytes(value)).digest("hex")}`;
const publicOperation = (raw: unknown) => {
  const { scope: _scope, requestHash: _hash, ...value } = operationSchema.parse(raw);
  return { ...value, connectionId: value.connectionId ?? DEFAULT_BRIDGE_CONNECTION };
};
type Operation = z.infer<typeof operationSchema>;
type ConnectionRecord = z.infer<typeof recordSchema>;
type RuntimeState = "UNCONFIGURED" | "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "DEGRADED" | "STORAGE_UNSUPPORTED" | "STORAGE_UNCERTAIN" | "STOPPED";
type SessionFactory = typeof createErpbridgeMcpSession;
type RuntimeOptions = { repository: Repository; registries: RegistryService; validator: RegistryValidator; config: AppConfig; connection?: ErpbridgeConnectionConfig; factory?: SessionFactory; userMcpCredentials?: import("./user-mcp-credentials.js").UserMcpCredentials; deferConnection?: boolean };

/** One backend-owned environment-backed modern connection. This is not a
 * generic URL registry: browser/model supplied endpoints and credentials are
 * rejected. No business call, automatic new-session reconnect, or tool grant
 * here. The adapter may recover only an existing notification GET stream. */
export class McpConnectionRuntime {
  #session: ErpbridgeMcpSession | undefined;
  #state: RuntimeState = "DISCONNECTED";
  #controller: AbortController | undefined;
  #epoch = 0;
  #stopped = false;
  #revision = 0;
  #probeBusy = false;
  #deferredRestore: Promise<void> | undefined;
  #probeController: AbortController | undefined;
  readonly #disposals = new Set<Promise<void>>();
  readonly #configurationHash: string;
  readonly #configured: boolean;
  readonly connection: ErpbridgeConnectionConfig;
  private constructor(readonly options: RuntimeOptions) {
    const config = options.config;
    // Direct runtime construction remains the compatibility path for the
    // legacy single-connection fields. The manager always passes an explicit
    // catalog entry, so one connection cannot silently borrow another one's
    // endpoint or credential during configuration changes.
    this.connection = options.connection ?? { id: DEFAULT_BRIDGE_CONNECTION, baseURL: config.erpbridgeBaseURL,
      mcpToken: config.erpbridgeMcpToken, tokenReference: config.erpbridgeMcpTokenReference || "ERPBRIDGE_MCP_TOKEN", roleMap: config.erpbridgeRoleMap, primary: true };
    this.#configured = config.mcpTransport === "erpbridge-mcp" && Boolean(this.connection.baseURL && this.connection.mcpToken);
    if (this.#configured) validateOwnedConfiguration(config, this.connection);
    this.#configurationHash = digest([config.mcpTransport, this.connection.id, this.connection.baseURL, this.connection.mcpToken, this.connection.roleMap]);
  }
  static async open(options: RuntimeOptions) {
    const runtime = new McpConnectionRuntime(options);
    const residentStartup = bindExecutionHost(options.repository) === "resident-server";
    if (!runtime.supportedStorage()) { runtime.#state = "STORAGE_UNSUPPORTED"; return runtime; }
    const unchanged = !residentStartup ? await options.repository.readAuthoritative(state => {
      const raw=state.mcpConnections[runtime.connection.id];
      if(!raw)return undefined;
      const record=recordSchema.parse(raw);
      return record.configurationHash===runtime.#configurationHash?record:undefined;
    }) : undefined;
    const record = unchanged ?? await options.repository.mutate(state => {
      const old = state.mcpConnections[runtime.connection.id];
      let value: ConnectionRecord = old ? recordSchema.parse(old) : { id: runtime.connection.id, revision: 1, desiredEnabled: false, configurationHash: runtime.#configurationHash, updatedAt: now() };
      // No stored live socket is trusted after a process restart. Interrupted
      // admin operations require an explicit new decision, not auto-completion.
      let interrupted = false;
      for (const raw of residentStartup ? Object.values(state.mcpConnectionOperations) : []) {
        const operation = operationSchema.parse(raw);
        if ((operation.connectionId ?? DEFAULT_BRIDGE_CONNECTION) === runtime.connection.id && operation.state === "RUNNING") {
          state.mcpConnectionOperations[operation.id] = { ...operation, connectionId: runtime.connection.id, state: "INTERRUPTED", reason: "MCP_OPERATION_INTERRUPTED", completedAt: now() };
          if (operation.action !== "test") interrupted = true;
        }
      }
      if (interrupted || value.configurationHash !== runtime.#configurationHash) value = { ...value, revision: value.revision + 1, desiredEnabled: false, configurationHash: runtime.#configurationHash, updatedAt: now() };
      state.mcpConnections[runtime.connection.id] = value;
      return value;
    });
    runtime.#revision = record.revision; runtime.#state = runtime.#configured ? "DISCONNECTED" : "UNCONFIGURED";
    // Persisted enabled intent may restore only the same configured revision.
    // This is initialize/discovery, never replay of a business operation.
    const blocked = await options.repository.readAuthoritative(state => runtime.running(state, record).some(operation => operation.action !== "test"));
    if (runtime.#configured && record.desiredEnabled && !blocked && !options.deferConnection) await runtime.restore(record);
    return runtime;
  }
  get session(): ErpbridgeMcpSession | undefined {
    if (this.#state !== "CONNECTED" || this.#stopped || this.#session?.available === false) return undefined;
    return this.#session;
  }
  /** Configuration identity only, NEVER evidence of a connected session or
   * permission to call tools. Deferred admissions and live workers bind to
   * the same endpoint/token/revision without doing network I/O at admission. */
  get admissionConfigurationBinding(): string | undefined {
    return this.#configured && this.#revision>0 ? createHash("sha256").update(JSON.stringify([this.connection.baseURL.trim(),this.connection.mcpToken,`${this.connection.id}:${this.#revision}`])).digest("hex") : undefined;
  }
  get primaryConnectionId() { return this.connection.id; }
  hasConnection(id: string) { return id === this.connection.id; }
  connectionCatalog() { return [{ id: this.connection.id, primary: this.connection.primary, dispatchSupported: true }]; }
  sessionFor(id: string) { return id === this.connection.id ? this.session : undefined; }
  /** Lazy startup restoration only. Never enables a disabled connection,
   * retries a degraded session or changes its reviewed configuration. */
  async ensureSession(id = this.connection.id): Promise<void> {
    if (id !== this.connection.id || this.session || this.#stopped || !this.#configured || this.#state !== "DISCONNECTED") return;
    if (this.#deferredRestore) return this.#deferredRestore;
    this.#deferredRestore = (async () => {
      const record = await this.options.repository.readAuthoritative(state => {
        const raw = state.mcpConnections[this.connection.id];
        if (!raw) return undefined;
        const value = recordSchema.parse(raw);
        return value.desiredEnabled && value.revision === this.#revision && value.configurationHash === this.#configurationHash && !this.running(state, value).length ? value : undefined;
      });
      if (record && !this.#stopped && this.#state === "DISCONNECTED") await this.restore(record);
    })();
    return this.#deferredRestore;
  }
  roleMapFor(id: string) { return id === this.connection.id ? this.connection.roleMap : undefined; }
  private supportedStorage() { return this.options.repository.persistence === null || this.options.repository.persistence.readQueueDurability === "encrypted-single-writer"; }
  private running(state: Readonly<RepositoryState>, record: ConnectionRecord) {
    return Object.values(state.mcpConnectionOperations).map(raw => operationSchema.parse(raw)).filter(operation =>
      (operation.connectionId ?? DEFAULT_BRIDGE_CONNECTION) === this.connection.id && operation.revision === record.revision && operation.state === "RUNNING");
  }
  private requireStorage() { if (!this.supportedStorage()) throw new HandlerFailure(503, "MCP lifecycle requires supported single-writer storage", { code: "MCP_STORAGE_UNSUPPORTED" }); }
  private authority(state: Readonly<RepositoryState>, user: CurrentUser, mutation: boolean) {
    const permissions = assertActorAuthority(state, user);
    if (!permissions.includes("settings:manage") || (mutation && user.role !== "Platform Admin")) throw new HandlerFailure(403, "Current Platform Admin settings authority is required for MCP lifecycle changes", { code: "MCP_ADMIN_REQUIRED" });
  }
  private invalidate(next: RuntimeState) {
    this.#epoch++; this.#state = next; this.#controller?.abort(); this.#controller = undefined;
    this.#probeController?.abort(); this.#probeController = undefined;
    const old = this.#session; this.#session = undefined;
    if (old) {
      const disposal = this.dispose(old); this.#disposals.add(disposal);
      void disposal.finally(() => this.#disposals.delete(disposal)).catch(() => {});
    }
  }
  private async dispose(session: ErpbridgeMcpSession) {
    try { await boundedOperation(() => session.close(), { timeoutMs: Math.min(1000, this.options.config.mcpTimeoutMs), label: "MCP session disposal" }); }
    catch (error) { if (bindExecutionHost(this.options.repository) === "bounded-invocation") throw error; }
  }
  private async assertRevision(revision: number, epoch: number) {
    if (this.#stopped || epoch !== this.#epoch || this.#state !== "CONNECTED") throw new Error("MCP connection was superseded or disconnected");
    await this.options.repository.readAuthoritative(state => {
      const record = recordSchema.parse(state.mcpConnections[this.connection.id]);
      if (!record.desiredEnabled || record.revision !== revision || record.configurationHash !== this.#configurationHash) throw new Error("MCP connection authority changed");
    });
    if (this.#stopped || epoch !== this.#epoch || this.#state !== "CONNECTED") throw new Error("MCP connection changed during admission");
  }
  private async initialize(revision: number, epoch: number, controller: AbortController) {
    const { config, repository, registries, validator } = this.options;
    let candidate: ErpbridgeMcpSession | undefined;
    const authorizer = admissionAuthorizer(repository, registries, this.connection.id);
    return boundedOperation(async () => {
      candidate = await (this.options.factory ?? createErpbridgeMcpSession)({ baseURL: this.connection.baseURL, token: this.connection.mcpToken,
        ...(this.options.userMcpCredentials ? { userMcpCredentials: this.options.userMcpCredentials } : {}),
        timeoutMs: config.mcpTimeoutMs, validator, signal: controller.signal, connectionId: this.connection.id, connectionRevision: `${this.connection.id}:${revision}`,
        administratorChatActions:config.erpbridgeAdminChatActions===true,
        admissionAuthorizer: async (definition, binding, pin) => { await this.assertRevision(revision, epoch); await authorizer(definition, binding, pin); await this.assertRevision(revision, epoch); } });
      if (controller.signal.aborted || epoch !== this.#epoch || this.#stopped) { await this.dispose(candidate); throw new Error("MCP initialization superseded"); }
      if (candidate.available === false || candidate.requiresReviewedRevision !== true || !/^[a-f0-9]{64}$/.test(candidate.admissionBinding ?? "")) throw new Error("Unsupported initialized MCP profile");
      const generation = candidate.discoveryGeneration ?? 0;
      const tools = await candidate.listTools(controller.signal);
      if (tools.length > 2048 || canonicalJSONBytes(tools).length > 2000000 || tools.some(tool => !tool.name?.trim() || tool.name.length > 256) || new Set(tools.map(tool => tool.name)).size !== tools.length || generation !== (candidate.discoveryGeneration ?? 0)) throw new Error("Incomplete or changed MCP inventory");
      return { session: candidate, discoveryCount: tools.length };
    }, { timeoutMs: config.mcpTimeoutMs, label: "MCP initialize and discovery", signal: controller.signal,
      onAbandon: () => { controller.abort(); if (candidate) void this.dispose(candidate); },
      onLateSettlement: () => { if (candidate) void this.dispose(candidate); } }).catch(async error => { if (candidate) await this.dispose(candidate); throw error; });
  }
  private async restore(record: ConnectionRecord) {
    this.#state = "CONNECTING"; const epoch = ++this.#epoch, controller = new AbortController(); this.#controller = controller;
    let initialized: Awaited<ReturnType<McpConnectionRuntime["initialize"]>> | undefined;
    try {
      initialized = await this.initialize(record.revision, epoch, controller);
      await this.options.repository.readAuthoritative(state => { const current = recordSchema.parse(state.mcpConnections[record.id]); if (!current.desiredEnabled || current.revision !== record.revision) throw new Error("MCP restore superseded"); });
      if (epoch !== this.#epoch || this.#stopped) { await this.dispose(initialized.session); return; }
      this.#session = initialized.session; this.#state = "CONNECTED";
    } catch { if (initialized) await this.dispose(initialized.session); if (epoch === this.#epoch) this.invalidate("DEGRADED"); }
  }
  private view(record: ConnectionRecord | null, durableBusy = false) {
    const state = this.#stopped ? "STOPPED" : this.#state === "CONNECTED" && (this.#session?.available === false || !record?.desiredEnabled || record.revision !== this.#revision || record.configurationHash !== this.#configurationHash) ? "DEGRADED" : this.#state;
    const canInitialize = this.#configured && this.supportedStorage() && !this.#stopped && this.#state !== "CONNECTING" && !this.#probeBusy && !durableBusy;
    return { id: this.connection.id, transport: "erpbridge-mcp", configurationSource: "backend-environment", secretReference: this.connection.tokenReference,
      primary: this.connection.primary, dispatchSupported: true, configured: this.#configured,
      revision: record?.revision ?? this.#revision, desiredEnabled: record?.desiredEnabled ?? false, state,
      initialized: state === "CONNECTED" && Boolean(this.session), discoveryAvailable: state === "CONNECTED" && Boolean(this.session), qualification: "Initialization/discovery only; not live ERP tool authorization or delivery",
      notificationStream: this.#session?.notificationState ?? null,
      persistence: !this.supportedStorage() ? "unsupported" : this.options.repository.persistence === null ? "memory-only" : "durable-single-writer",
      operationInProgress: durableBusy || this.#probeBusy || this.#state === "CONNECTING",
      supports: { connect: canInitialize, test: canInitialize, disconnect: this.supportedStorage() && !this.#stopped },
      configurationChange: "Endpoint/secret rotation requires backend configuration and restart; re-review after connection revision changes" };
  }
  async status(user: CurrentUser) {
    return this.options.repository.readAuthoritative(state => {
      this.authority(state, user, false);
      const raw = state.mcpConnections[this.connection.id]; const record = raw ? recordSchema.parse(raw) : null;
      return { connections: [this.view(record, record ? this.running(state, record).length > 0 : false)], recentOperations: Object.values(state.mcpConnectionOperations).filter(item => (operationSchema.parse(item).connectionId ?? DEFAULT_BRIDGE_CONNECTION) === this.connection.id).reverse().slice(0, 10).map(publicOperation) };
    });
  }
  async command(action: "connect" | "disconnect" | "test", user: CurrentUser, body: unknown, request?: FastifyRequest, targetConnectionId = this.connection.id) {
    if (targetConnectionId !== this.connection.id) throw new HandlerFailure(404, "MCP connection not found");
    this.requireStorage();
    const parsed = connectionCommandSchema.safeParse(body);
    if (!parsed.success) throw new HandlerFailure(400, "Provide current connection revision and stable request ID only", { code: "MCP_COMMAND_INVALID" });
    const data = parsed.data, scope = digest([user.id, this.connection.id, action, data.requestId]), requestHash = digest(data);
    let transitionStarted = false;
    const claimed = await this.options.repository.mutate(state => {
      this.authority(state, user, true);
      const previous = Object.values(state.mcpConnectionOperations).find(raw => raw.scope === scope);
      const record = recordSchema.parse(state.mcpConnections[this.connection.id]);
      if (previous) { const operation = operationSchema.parse(previous); if (operation.requestHash !== requestHash) throw new HandlerFailure(409, "Request ID belongs to different connection input", { code: "MCP_REQUEST_CONFLICT" }); return { operation, record, duplicate: true }; }
      if (this.#stopped) throw new HandlerFailure(503, "MCP runtime stopped", { code: "MCP_RUNTIME_STOPPED" });
      if (record.revision !== data.baseRevision) throw new HandlerFailure(409, "Connection revision changed; reload before a new operation", { code: "MCP_REVISION_CONFLICT" });
      if (action !== "disconnect" && !this.#configured) throw new HandlerFailure(503, "Configure the backend ERPBridge endpoint and credential reference first", { code: "MCP_NOT_CONFIGURED" });
      if (action !== "disconnect" && (this.#state === "CONNECTING" || this.#probeBusy)) throw new HandlerFailure(409, "A bounded MCP initialization/test is already in progress", { code: "MCP_OPERATION_IN_PROGRESS" });
      if (action !== "disconnect" && this.running(state, record).length) throw new HandlerFailure(409, "An original MCP operation is unresolved", { code: "MCP_OPERATION_IN_PROGRESS" });
      if (Object.keys(state.mcpConnectionOperations).length >= 1000) throw new HandlerFailure(429, "MCP operation history retention limit reached", { code: "MCP_HISTORY_LIMIT" });
      const updated = action === "test" ? record : { ...record, revision: record.revision + 1, desiredEnabled: action === "connect", updatedAt: now() };
      if (action === "disconnect") for (const operation of this.running(state, record))
        state.mcpConnectionOperations[operation.id] = { ...operation, state: "INTERRUPTED", reason: "MCP_OPERATION_INTERRUPTED", completedAt: now() };
      const operation: Operation = { id: nextID(state, "mcpop"), actorId: user.id, connectionId: this.connection.id, action, scope, requestHash, requestId: data.requestId, revision: updated.revision, state: "RUNNING", startedAt: now() };
      transitionStarted = true;
      if (action !== "test") { this.invalidate(action === "connect" ? "CONNECTING" : "DISCONNECTED"); this.#revision = updated.revision; }
      else this.#probeBusy = true;
      state.mcpConnections[this.connection.id] = updated; state.mcpConnectionOperations[operation.id] = operation;
      appendAudit(state, user, `mcp.${action}.requested`, "connection", this.connection.id, { revision: record.revision }, { operationId: operation.id, revision: updated.revision }, request);
      return { operation, record: updated, duplicate: false };
    }).catch(error => { if (transitionStarted || !(error instanceof HandlerFailure)) this.invalidate("STORAGE_UNCERTAIN"); if (transitionStarted) this.#probeBusy = false; throw error; });
    if (claimed.duplicate) return { operation: publicOperation(claimed.operation), connection: await this.options.repository.readAuthoritative(state => this.view(claimed.record, this.running(state, claimed.record).length > 0)), duplicate: true };
    const epoch = this.#epoch, controller = new AbortController();
    if (action === "connect") this.#controller = controller;
    if (action === "test") this.#probeController = controller;
    let initialized: Awaited<ReturnType<McpConnectionRuntime["initialize"]>> | undefined;
    try {
      if (action !== "disconnect") initialized = await this.initialize(claimed.record.revision, epoch, controller);
      const completed = await this.options.repository.mutate(state => {
        this.authority(state, user, true);
        const record = recordSchema.parse(state.mcpConnections[this.connection.id]);
        if (record.revision !== claimed.record.revision || epoch !== this.#epoch || this.#stopped) throw new HandlerFailure(409, "MCP operation superseded", { code: "MCP_OPERATION_INTERRUPTED" });
        const operation = operationSchema.parse(state.mcpConnectionOperations[claimed.operation.id]);
        if (operation.state !== "RUNNING") throw new Error("MCP operation no longer running");
        const updated = { ...operation, state: "DONE" as const, completedAt: now(), ...(initialized ? { discoveryCount: initialized.discoveryCount } : {}) };
        state.mcpConnectionOperations[operation.id] = updated;
        appendAudit(state, user, `mcp.${action}.completed`, "connection", this.connection.id, null, { operationId: operation.id, revision: record.revision, discoveryCount: initialized?.discoveryCount ?? null }, request);
        return updated;
      });
      if (action === "connect" && initialized && epoch === this.#epoch && !this.#stopped) { this.#session = initialized.session; this.#state = "CONNECTED"; }
      else if (initialized) await this.dispose(initialized.session);
      const connection = await this.options.repository.readAuthoritative(state => this.view(recordSchema.parse(state.mcpConnections[this.connection.id])));
      return { operation: publicOperation(completed), connection, duplicate: false };
    } catch (error) {
      controller.abort(); if (initialized) await this.dispose(initialized.session);
      const superseded = epoch !== this.#epoch || this.#stopped;
      if (action === "connect" && epoch === this.#epoch) this.invalidate("DEGRADED");
      const reason: Operation["reason"] = error instanceof OperationDeadlineExceeded ? "MCP_WAIT_TIMEOUT" : error instanceof HandlerFailure && error.status === 403 ? "MCP_ACTOR_REVOKED" : superseded ? "MCP_OPERATION_INTERRUPTED" : "MCP_OPERATION_FAILED";
      try { await this.options.repository.mutate(state => {
        const operation = operationSchema.parse(state.mcpConnectionOperations[claimed.operation.id]);
        if (operation.state === "RUNNING") { state.mcpConnectionOperations[operation.id] = { ...operation, state: "FAILED", reason, completedAt: now() };
          const record = recordSchema.parse(state.mcpConnections[this.connection.id]);
          if (action === "connect" && record.revision === claimed.record.revision) state.mcpConnections[this.connection.id] = { ...record, desiredEnabled: false, updatedAt: now() };
          appendAudit(state, user, `mcp.${action}.failed`, "connection", this.connection.id, null, { operationId: operation.id, reason }, request); }
      }); } catch { this.invalidate("STORAGE_UNCERTAIN"); }
      // Upstream headers/bodies/errors may contain credentials. Never expose or
      // save them. The operation receipt is the recovery identity.
      throw new HandlerFailure(error instanceof HandlerFailure && error.status === 403 ? 403 : 502, "MCP operation did not establish confirmed readiness; reload its saved operation before deciding on another request", { code: reason, operationId: claimed.operation.id });
    } finally { if (action === "test") { this.#probeBusy = false; this.#probeController = undefined; } }
  }
  async stop() { this.#stopped = true; this.invalidate("STOPPED"); await Promise.all([...this.#disposals]); }
}

/** Owns a bounded set of independently revisioned backend connections.
 * Workflow dispatch is allowed only through an immutable per-node connection
 * pin captured from that connection's reviewed capability revision. */
export class McpConnectionManager {
  private constructor(readonly runtimes: ReadonlyMap<string, McpConnectionRuntime>, readonly primaryConnectionId: string) {}
  static async open(options: Omit<RuntimeOptions, "connection">) {
    const opened = new Map<string, McpConnectionRuntime>();
    try {
      const connections = options.config.erpbridgeConnections.length ? options.config.erpbridgeConnections : [{ id: DEFAULT_BRIDGE_CONNECTION, baseURL: options.config.erpbridgeBaseURL,
        mcpToken: options.config.erpbridgeMcpToken, tokenReference: options.config.erpbridgeMcpTokenReference || "ERPBRIDGE_MCP_TOKEN", roleMap: options.config.erpbridgeRoleMap, primary: true }];
      for (const connection of connections) opened.set(connection.id, await McpConnectionRuntime.open({ ...options, connection }));
      const primary = connections.find(value => value.primary)?.id ?? options.config.erpbridgePrimaryConnectionId;
      if (!opened.has(primary)) throw new Error("Configured primary ERPBridge connection is unavailable");
      return new McpConnectionManager(opened, primary);
    } catch (error) { await Promise.allSettled([...opened.values()].map(runtime => runtime.stop())); throw error; }
  }
  get session() { return this.runtimes.get(this.primaryConnectionId)?.session; }
  get admissionConfigurationBinding() { return this.runtimes.get(this.primaryConnectionId)?.admissionConfigurationBinding; }
  hasConnection(id: string) { return this.runtimes.has(id); }
  connectionCatalog() { return [...this.runtimes.values()].map(runtime => ({ id: runtime.connection.id, primary: runtime.connection.primary,
    dispatchSupported: true })).sort((a, b) => Number(b.primary) - Number(a.primary) || a.id.localeCompare(b.id)); }
  sessionFor(id = this.primaryConnectionId) { return this.runtimes.get(id)?.session; }
  async ensureSession(id = this.primaryConnectionId) { await this.runtimes.get(id)?.ensureSession(id); }
  roleMapFor(id = this.primaryConnectionId) { return this.runtimes.get(id)?.roleMapFor(id); }
  async status(user: CurrentUser) {
    const parts = await Promise.all([...this.runtimes.values()].map(runtime => runtime.status(user)));
    const connections = parts.flatMap(value => value.connections).sort((a, b) => Number(b.primary) - Number(a.primary) || a.id.localeCompare(b.id));
    const recentOperations = parts.flatMap(value => value.recentOperations).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)).slice(0, 50);
    return { connections, recentOperations, primaryConnectionId: this.primaryConnectionId,
      dispatchScope: "A workflow node may dispatch only through its immutable reviewed connection pin; lifecycle readiness alone grants no execution authority" };
  }
  async command(action: "connect" | "disconnect" | "test", user: CurrentUser, body: unknown, request?: FastifyRequest, targetConnectionId = this.primaryConnectionId) {
    const runtime = this.runtimes.get(targetConnectionId); if (!runtime) throw new HandlerFailure(404, "MCP connection not found");
    return runtime.command(action, user, body, request, targetConnectionId);
  }
  async stop() {
    const outcomes = await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.stop()));
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(failure => failure.reason), "MCP manager cleanup was not confirmed");
  }
}

function validateOwnedConfiguration(config: AppConfig, connection: ErpbridgeConnectionConfig) {
  let url: URL; try { url = new URL(connection.baseURL); } catch { throw new Error("Invalid backend ERPBridge endpoint"); }
  if (!["http:", "https:"].includes(url.protocol) || (config.environment !== "development" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/" || /[\r\n]/.test(connection.mcpToken) || connection.mcpToken.length > 16384)
    throw new Error("Backend ERPBridge endpoint/credential is not supported by the explicit modern adapter");
}
