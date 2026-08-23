import { randomBytes } from "node:crypto";
import { AsyncMutex } from "./async-mutex.js";
import type { Principal, Workflow } from "../models/schemas.js";

export type Role = { id: string; name: string; description: string; permissions: string[]; createdAt: string };
export type User = {
  id: string;
  name: string;
  email: string;
  roleId: string;
  permissionOverrides: string[];
  status: string;
  initials: string;
  timezone?: string;
  departmentId: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  twoFactorEnabled?: boolean;
  emailVerified?: boolean;
};

export type Execution = {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  tokens: { input: number; output: number; total: number };
  costUsd: number;
  startedBy: Principal;
  failure?: Record<string, unknown>;
  stepOutputs?: Record<string, unknown>;
  finalOutput?: unknown;
};

export type Permission = { key: string; name: string; description: string; group: string };
export type StoredRecord = Record<string, unknown>;
export type ChatSessionRecord = {
  id: string;
  ownerId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  messages: StoredRecord[];
};

export type InvocationProvenanceRecord = {
  id: string;
  promptTemplateVersion: string;
  promptSha256: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  measured: boolean;
  latencyMs: number;
  temperature: number;
  fallbackUsed: boolean;
  status: "SUCCEEDED" | "FAILED";
  createdAt: string;
};

export type RepositoryState = {
  version: 1;
  counter: number;
  users: Record<string, User>;
  passwordHashes: Record<string, string>;
  roles: Record<string, Role>;
  permissions: Permission[];
  workflows: Record<string, Workflow>;
  versions: Record<string, StoredRecord[]>;
  templates: Record<string, StoredRecord>;
  executions: Record<string, Execution>;
  executionLogs: Record<string, StoredRecord[]>;
  timelines: Record<string, StoredRecord[]>;
  healing: Record<string, StoredRecord>;
  chats: Record<string, ChatSessionRecord>;
  invocationProvenance: Record<string, InvocationProvenanceRecord>;
  governancePolicy: StoredRecord | null;
  company: StoredRecord | null;
  providers: Record<string, StoredRecord>;
  integrations: Record<string, StoredRecord>;
  webhooks: Record<string, StoredRecord>;
  refreshSessions: Record<string, { userId: string; expiresAt: string }>;
  auditLogs: Record<string, unknown>[];
  settings: Record<string, unknown>;
  notifications: Record<string, StoredRecord>;
  notificationPreferences: Record<string, StoredRecord>;
  apiKeys: Record<string, StoredRecord>;
  uploads: Record<string, StoredRecord>;
  uploadContents: Record<string, string>;
  importHistory: StoredRecord[];
  registryContextHistory: StoredRecord[];
};

export interface PersistenceBackend {
  load(): Promise<Uint8Array | null>;
  save(payload: Uint8Array): Promise<void>;
  probe(): Promise<void>;
  close(): Promise<void>;
}

export class Repository {
  readonly #mutex = new AsyncMutex();
  #state: RepositoryState;
  #committed: RepositoryState;
  #healthy = true;

  constructor(readonly persistence: PersistenceBackend | null = null, initial = initialState()) {
    this.#state = structuredClone(initial);
    this.#committed = structuredClone(initial);
  }

  static async open(persistence: PersistenceBackend | null): Promise<Repository> {
    if (persistence === null) return new Repository(null);
    const payload = await persistence.load();
    const restored = payload === null ? initialState() : restoreState(payload);
    const repository = new Repository(persistence, restored);
    await persistence.save(Buffer.from(JSON.stringify(restored), "utf8"));
    return repository;
  }

  async snapshot(): Promise<RepositoryState> {
    return this.#mutex.runExclusive(() => structuredClone(this.#state));
  }

  async read<T>(reader: (state: Readonly<RepositoryState>) => T): Promise<T> {
    return this.#mutex.runExclusive(() => reader(this.#state));
  }

  async mutate<T>(mutation: (state: RepositoryState) => Promise<T> | T): Promise<T> {
    return this.#mutex.runExclusive(async () => {
      const before = structuredClone(this.#state);
      let persistenceAttempted = false;
      try {
        const result = await mutation(this.#state);
        if (this.persistence !== null) {
          const bytes = Buffer.from(JSON.stringify(this.#state), "utf8");
          persistenceAttempted = true;
          await this.persistence.save(bytes);
        }
        this.#committed = structuredClone(this.#state);
        this.#healthy = true;
        return result;
      } catch (error) {
        this.#state = before;
        this.#committed = structuredClone(before);
        if (persistenceAttempted) this.#healthy = false;
        throw error;
      }
    });
  }

  async persistenceStatus(): Promise<{ durable: boolean; healthy: boolean }> {
    if (this.persistence === null) return { durable: false, healthy: true };
    try {
      await this.persistence.probe();
      this.#healthy = true;
    } catch {
      this.#healthy = false;
    }
    return { durable: true, healthy: this.#healthy };
  }

  async nextID(prefix: string): Promise<string> {
    return this.mutate((state) => {
      state.counter += 1;
      return `${prefix}_${state.counter}_${randomBytes(4).toString("hex")}`;
    });
  }

  async close(): Promise<void> {
    await this.persistence?.close();
  }

  async effectiveUser(userId: string): Promise<(User & { role: string; permissions: string[] }) | null> {
    return this.read((state) => {
      const user = state.users[userId];
      if (user === undefined) return null;
      const role = state.roles[user.roleId];
      const permissions = [...new Set([...(role?.permissions ?? []), ...user.permissionOverrides].filter((item) => item !== ""))];
      return { ...structuredClone(user), role: role?.name ?? "", permissions };
    });
  }
}

function restoreState(payload: Uint8Array): RepositoryState {
  const decoded: unknown = JSON.parse(Buffer.from(payload).toString("utf8"));
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw new Error("stored repository state must be a JSON object");
  const source = decoded as Partial<RepositoryState>;
  if (source.version !== 1) throw new Error(`unsupported stored repository version ${String(source.version)}`);
  const defaults = initialState();
  const restored: RepositoryState = { ...defaults, ...source } as RepositoryState;
  for (const key of ["users", "passwordHashes", "roles", "workflows", "versions", "templates", "executions", "executionLogs", "timelines", "healing", "chats", "invocationProvenance", "providers", "integrations", "webhooks", "refreshSessions", "notifications", "notificationPreferences", "apiKeys", "uploads", "uploadContents"] as const) {
    if (typeof restored[key] !== "object" || restored[key] === null || Array.isArray(restored[key])) restored[key] = defaults[key] as never;
  }
  if (restored.governancePolicy !== null && (typeof restored.governancePolicy !== "object" || Array.isArray(restored.governancePolicy))) restored.governancePolicy = null;
  for (const role of Object.values(defaults.roles)) if (restored.roles[role.id] === undefined) restored.roles[role.id] = role;
  const knownPermissions = new Set(restored.permissions.map((item) => item.key));
  for (const permission of defaults.permissions) if (!knownPermissions.has(permission.key)) restored.permissions.push(permission);
  restored.counter = Math.max(0, Number.isInteger(restored.counter) ? restored.counter : 0);
  return restored;
}

export function initialState(): RepositoryState {
  const createdAt = new Date().toISOString();
  const permissionKeys = ["workflow:read", "workflow:write", "workflow:run", "workflow:read_own", "workflow:run_own", "execution:read_own", "workflow_view_all", "chat:use", "registry:read", "registry:write", "settings:manage", "provider:manage", "user:manage", "audit:read"];
  const permissions = permissionKeys.map((key) => ({ key, name: permissionName(key), description: permissionDescription(key), group: permissionGroup(key) }));
  return {
    version: 1,
    counter: 0,
    users: {},
    passwordHashes: {},
    refreshSessions: {},
    workflows: {},
    versions: {},
    templates: {},
    executions: {},
    executionLogs: {},
    timelines: {},
    healing: {},
    chats: {},
    invocationProvenance: {},
    governancePolicy: null,
    company: null,
    providers: {},
    integrations: {},
    webhooks: {},
    auditLogs: [],
    settings: { general: {}, llm: {}, rbac: {} },
    notifications: {},
    notificationPreferences: {},
    apiKeys: {},
    uploads: {},
    uploadContents: {},
    importHistory: [],
    registryContextHistory: [],
    permissions,
    roles: {
      role_admin: { id: "role_admin", name: "Platform Admin", description: "Full platform access", permissions: permissionKeys, createdAt },
      role_system_admin: { id: "role_system_admin", name: "System Admin", description: "System administration", permissions: ["user:manage", "registry:read", "audit:read"], createdAt },
      role_builder: { id: "role_builder", name: "Workflow Builder", description: "Workflow creation", permissions: ["workflow:read", "workflow:write", "workflow:run", "workflow_view_all", "chat:use", "registry:read"], createdAt },
      role_client: { id: "role_client", name: "Client", description: "Assigned workflow access", permissions: ["chat:use", "workflow:read_own", "workflow:run_own", "execution:read_own"], createdAt },
    },
  };
}

function permissionName(key: string): string {
  return key.split(/[._:]/).map((part) => part.length === 0 ? part : `${part[0]!.toUpperCase()}${part.slice(1)}`).join(" ");
}

function permissionGroup(key: string): string {
  if (key.startsWith("workflow") || key.startsWith("execution") || key.startsWith("chat")) return "Workflow";
  if (key.startsWith("registry")) return "Registry";
  if (key.startsWith("user") || key.startsWith("audit")) return "Administration";
  return "Settings";
}

function permissionDescription(key: string): string {
  const descriptions: Record<string, string> = {
    "workflow:run": "Start, cancel, and retry workflow executions",
    "workflow:read": "Read all workflows",
    "workflow:write": "Create and update workflows",
    "user:manage": "Manage users and roles",
    "audit:read": "Read the audit log",
  };
  return descriptions[key] ?? permissionName(key);
}
