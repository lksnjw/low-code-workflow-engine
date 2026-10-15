import { resolve } from "node:path";
import { z } from "zod";
import { validateFirestoreNamespace } from "../storage/firestore-record-codec.js";
import { decodeEncryptionKey } from "../storage/aes-gcm.js";

const environmentSchema = z
  .object({
    APP_NAME: z.string().optional(),
    APP_ENV: z.string().optional(),
    CHAT_INTENT_ROUTING: z.enum(["agent", "patterns"]).optional(),
    PORT: z.string().optional(),
    API_BASE_PATH: z.string().optional(),
    JWT_SECRET: z.string().optional(),
    TOKEN_TTL_SECONDS: z.string().optional(),
    ALLOW_PUBLIC_REGISTRATION: z.string().optional(),
    TOOL_REGISTRY_PATH: z.string().optional(),
    RULE_REGISTRY_PATH: z.string().optional(),
    STORAGE_DRIVER: z.string().optional(),
    DATABASE_URL: z.string().optional(),
    STORAGE_ENCRYPTION_KEY: z.string().optional(),
    MCP_BASE_URL: z.string().optional(),
    MCP_MODE: z.string().optional(),
    MCP_TRANSPORT: z.string().optional(),
    MCP_TIMEOUT_MS: z.string().optional(),
    FUNCTIONS_WRITER_ADMISSION_TIMEOUT_MS: z.string().optional(),
    FUNCTIONS_CHAT_TASK_TIMEOUT_MS: z.string().optional(),
    BACKEND_WORKER_CONCURRENCY: z.string().optional(),
    READ_WORKER_CONCURRENCY: z.string().optional(),
    READ_WORKER_PER_ACTOR: z.string().optional(),
    READ_WORKER_LEASE_MS: z.string().optional(),
    ERPBRIDGE_BASE_URL: z.string().optional(),
    ERPBRIDGE_MCP_TOKEN: z.string().optional(),
    ERPBRIDGE_MCP_TOKEN_ENV: z.string().optional(),
    ERPBRIDGE_ADMIN_ENV_ACCESS: z.string().optional(),
    ERPBRIDGE_ADMIN_CHAT_ACTIONS: z.string().optional(),
    ERPBRIDGE_ROLE_MAP: z.string().optional(),
    ERPBRIDGE_CONNECTIONS_JSON: z.string().optional(),
    ERPBRIDGE_PRIMARY_CONNECTION_ID: z.string().optional(),
    GENERATION_BASE_URL: z.string().optional(),
    GENERATION_API_KEY: z.string().optional(),
    GENERATION_MODEL_PRIMARY: z.string().optional(),
    GENERATION_MODEL_FALLBACK: z.string().optional(),
    GENERATION_ADDITIONAL_MODELS: z.string().optional(),
    GENERATION_TEMPERATURE: z.string().optional(),
    GENERATION_TIMEOUT_MS: z.string().optional(),
    GOVERNANCE_URL: z.string().optional(),
    GOVERNANCE_API_KEY: z.string().optional(),
    GOVERNANCE_TIMEOUT_MS: z.string().optional(),
    GOVERNANCE_SECONDARY_URL: z.string().optional(),
    GOVERNANCE_CACHE_TTL_MS: z.string().optional(),
    GOVERNANCE_FALLBACK_POLICY_PATH: z.string().optional(),
    GOVERNANCE_FALLBACK_LLM_API_KEY: z.string().optional(),
    GOVERNANCE_FALLBACK_LLM_MODEL: z.string().optional(),
    GOVERNANCE_FALLBACK_LLM_TIMEOUT_MS: z.string().optional(),
    FIRESTORE_PROJECT_ID: z.string().optional(),
    FIRESTORE_DATABASE_ID: z.string().optional(),
    FIRESTORE_WORKSPACE_ID: z.string().optional(),
    FIRESTORE_KEY_FILE: z.string().optional(),
    FIRESTORE_KEY_JSON: z.string().optional(),
    FIRESTORE_ENCRYPTION_KEY: z.string().optional(),
    FIRESTORE_CONTENT_FORMAT: z.enum(["encrypted-records/v1", "native-fields/v1"]).optional(),
    POLICY_GATE_URL: z.string().optional(),
    POLICY_GATE_API_KEY: z.string().optional(),
    POLICY_GATE_TIMEOUT_MS: z.string().optional(),
    PIPELINE_API_BASE_URL: z.string().optional(),
    PIPELINE_API_KEY: z.string().optional(),
    PIPELINE_TIMEOUT_MS: z.string().optional(),
    PIPELINE_WORKSPACE_ID: z.string().optional(),
    RAG_POLICY_API_BASE_URL: z.string().optional(),
    RAG_POLICY_API_KEY: z.string().optional(),
    RAG_POLICY_ADMIN_API_KEY: z.string().optional(),
    CORS_ORIGINS: z.string().optional(),
    PLATFORM_ADMIN_EMAIL: z.string().optional(),
    PLATFORM_ADMIN_PASSWORD: z.string().optional(),
  })
  .passthrough();

export type MCPTransport = "bridge-v1" | "erpbridge-mcp";

export type ErpbridgeConnectionConfig = {
  id: string;
  baseURL: string;
  mcpToken: string;
  tokenReference: string;
  roleMap: Record<string, string>;
  primary: boolean;
};

export type AppConfig = {
  appName: string;
  environment: string;
  /** Patterns is a compatibility/test mode, not the natural-language agent router. */
  chatIntentRouting?: "agent" | "patterns";
  erpbridgeAdminChatActions?: boolean;
  port: number;
  apiBasePath: string;
  jwtSecret: string;
  tokenTTLSeconds: number;
  allowPublicRegistration: boolean;
  toolRegistryPath: string;
  ruleRegistryPath: string;
  storageDriver: "memory" | "postgres" | "postgres-records" | "firestore" | "firestore-records";
  firestoreProjectId?: string;
  firestoreDatabaseId?: string;
  firestoreWorkspaceId?: string;
  firestoreKeyFile?: string;
  firestoreKeyJson?: Record<string, unknown>;
  firestoreEncryptionKey?: string;
  firestoreContentFormat?: "encrypted-records/v1" | "native-fields/v1";
  databaseURL: string;
  storageEncryptionKey: string;
  mcpBaseURL: string;
  mcpMode: "remote" | "mock";
  mcpTransport: MCPTransport;
  mcpTimeoutMs: number;
  functionsWriterAdmissionTimeoutMs?: number;
  functionsChatTaskTimeoutMs?: number;
  readWorkerConcurrency: number;
  readWorkerPerActor: number;
  readWorkerLeaseMs: number;
  erpbridgeBaseURL: string;
  erpbridgeMcpToken: string;
  erpbridgeMcpTokenReference: string;
  /** Explicit server-only opt-in for the built-in Platform Admin, never other roles. */
  erpbridgeAdminEnvironmentAccess?: boolean;
  erpbridgeRoleMap: Record<string, string>;
  erpbridgeConnections: ErpbridgeConnectionConfig[];
  erpbridgePrimaryConnectionId: string;
  generationBaseURL?: string;
  generationAPIKey?: string;
  generationModelPrimary?: string;
  generationModelFallback?: string;
  generationAdditionalModels?: string[];
  generationTemperature?: number;
  generationTimeoutMs?: number;
  governanceURL?: string;
  governanceAPIKey?: string;
  governanceTimeoutMs?: number;
  governanceSecondaryURL?: string;
  governanceCacheTTLms?: number;
  governanceFallbackPolicyPath: string;
  governanceFallbackLlmApiKey: string;
  governanceFallbackLlmModel: string;
  governanceFallbackLlmTimeoutMs: number;
  policyGateURL?: string;
  policyGateAPIKey?: string;
  policyGateTimeoutMs: number;
  pipelineAPIBaseURL?: string;
  pipelineAPIKey?: string;
  pipelineTimeoutMs?: number;
  pipelineWorkspaceId?: string;
  ragPolicyAPIBaseURL?: string;
  ragPolicyAPIKey?: string;
  ragPolicyAdminAPIKey?: string;
  corsOrigins: string[];
  platformAdminEmail: string;
  platformAdminPassword: string;
};

type McpConfigurationStatus = Pick<
  AppConfig,
  "mcpMode" | "mcpTransport" | "mcpBaseURL" | "erpbridgeConnections"
>;

/** Reports configured transport bindings only. This is not a live connection,
 * capability-admission or compatibility check. */
export function isMcpConfigured(config: McpConfigurationStatus): boolean {
  if (config.mcpMode === "mock") return true;
  if (config.mcpTransport === "erpbridge-mcp")
    return config.erpbridgeConnections.length > 0 && config.erpbridgeConnections.every(
      (connection) => connection.baseURL !== "" && connection.mcpToken !== "",
    );
  return config.mcpBaseURL !== "";
}

/*******************************************************************************
 * Function: loadConfig
 *
 * Loads application settings from environment values and validates them.
 ******************************************************************************/
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  root = process.cwd(),
  options: { administratorBootstrap?: "process-startup" | "external" } = {},
): AppConfig {
  if (options.administratorBootstrap !== undefined && !["process-startup", "external"].includes(options.administratorBootstrap))
    throw new Error("Unsupported administrator bootstrap policy");
  const source = environmentSchema.parse(env);
  const port = parseInteger(source.PORT, 8081, "PORT");
  const tokenTTLSeconds = parseInteger(
    source.TOKEN_TTL_SECONDS,
    3600,
    "TOKEN_TTL_SECONDS",
  );
  const mcpTimeoutMs = parseInteger(
    source.MCP_TIMEOUT_MS,
    30_000,
    "MCP_TIMEOUT_MS",
  );
  if (source.BACKEND_WORKER_CONCURRENCY !== undefined && source.READ_WORKER_CONCURRENCY !== undefined &&
      source.BACKEND_WORKER_CONCURRENCY !== source.READ_WORKER_CONCURRENCY)
    throw new Error("BACKEND_WORKER_CONCURRENCY and legacy READ_WORKER_CONCURRENCY must match when both are supplied");
  const workerConcurrencySource = source.BACKEND_WORKER_CONCURRENCY ?? source.READ_WORKER_CONCURRENCY;
  const readWorkerConcurrency = parseInteger(workerConcurrencySource, 2,
    source.BACKEND_WORKER_CONCURRENCY !== undefined ? "BACKEND_WORKER_CONCURRENCY" : "READ_WORKER_CONCURRENCY");
  const functionsWriterAdmissionTimeoutMs = parseInteger(source.FUNCTIONS_WRITER_ADMISSION_TIMEOUT_MS, 30_000, "FUNCTIONS_WRITER_ADMISSION_TIMEOUT_MS");
  const functionsChatTaskTimeoutMs = parseInteger(source.FUNCTIONS_CHAT_TASK_TIMEOUT_MS, 180_000, "FUNCTIONS_CHAT_TASK_TIMEOUT_MS");
  const readWorkerPerActor = parseInteger(source.READ_WORKER_PER_ACTOR, 1, "READ_WORKER_PER_ACTOR");
  const readWorkerLeaseMs = parseInteger(source.READ_WORKER_LEASE_MS, 30_000, "READ_WORKER_LEASE_MS");
  if (readWorkerConcurrency < 1 || readWorkerConcurrency > 8 || readWorkerPerActor < 1 || readWorkerPerActor > readWorkerConcurrency || readWorkerLeaseMs < 5000 || readWorkerLeaseMs > 300_000)
    throw new Error("Backend worker concurrency must be 1–8, per-actor concurrency 1–worker count, and lease duration 5000–300000 ms");
  const mcpTransport = nonblank(
    source.MCP_TRANSPORT?.trim().toLowerCase(),
    "bridge-v1",
  ) as AppConfig["mcpTransport"];
  if (mcpTransport !== "bridge-v1" && mcpTransport !== "erpbridge-mcp")
    throw new Error(
      `unsupported MCP_TRANSPORT ${JSON.stringify(mcpTransport)} (allowed values: bridge-v1 or erpbridge-mcp)`,
    );
  const erpbridgeConnections = mcpTransport === "erpbridge-mcp" ? parseErpbridgeConnections(env, source) : [];
  const primaryConnection = erpbridgeConnections.find(value => value.primary);
  const erpbridgeBaseURL = primaryConnection?.baseURL ?? "";
  const erpbridgeMcpToken = primaryConnection?.mcpToken ?? "";
  const erpbridgeMcpTokenReference = primaryConnection?.tokenReference ?? "";
  const erpbridgeRoleMap = primaryConnection?.roleMap ?? {};
  const erpbridgePrimaryConnectionId = primaryConnection?.id ?? "erpbridge-default";
  const generationTimeoutMs = parseInteger(
    source.GENERATION_TIMEOUT_MS,
    30_000,
    "GENERATION_TIMEOUT_MS",
  );
  const generationTemperature = parseNumber(
    source.GENERATION_TEMPERATURE,
    0,
    "GENERATION_TEMPERATURE",
  );
  const governanceTimeoutMs = parseInteger(
    source.GOVERNANCE_TIMEOUT_MS,
    10_000,
    "GOVERNANCE_TIMEOUT_MS",
  );
  const governanceCacheTTLMs = parseOptionalInteger(
    source.GOVERNANCE_CACHE_TTL_MS,
    "GOVERNANCE_CACHE_TTL_MS",
  );
  const governanceFallbackLlmTimeoutMs = parseInteger(
    source.GOVERNANCE_FALLBACK_LLM_TIMEOUT_MS,
    15_000,
    "GOVERNANCE_FALLBACK_LLM_TIMEOUT_MS",
  );
  const policyGateTimeoutMs = parseInteger(
    source.POLICY_GATE_TIMEOUT_MS,
    10_000,
    "POLICY_GATE_TIMEOUT_MS",
  );
  const pipelineTimeoutMs = parseInteger(
    source.PIPELINE_TIMEOUT_MS,
    180_000,
    "PIPELINE_TIMEOUT_MS",
  );
  const storageDriver = nonblank(
    source.STORAGE_DRIVER?.trim().toLowerCase(),
    "memory",
  ) as AppConfig["storageDriver"];
  if (!["memory", "postgres", "postgres-records", "firestore", "firestore-records"].includes(storageDriver))
    throw new Error(
      `unsupported STORAGE_DRIVER ${JSON.stringify(storageDriver)} (allowed values: memory, postgres, postgres-records, firestore, or firestore-records)`,
    );
  const mcpMode = nonblank(
    source.MCP_MODE?.trim().toLowerCase(),
    "remote",
  ) as AppConfig["mcpMode"];
  if (mcpMode !== "remote" && mcpMode !== "mock")
    throw new Error(`unsupported MCP_MODE ${JSON.stringify(mcpMode)}`);
  const apiBasePath = nonblank(source.API_BASE_PATH?.trim(), "/api");
  if (!apiBasePath.startsWith("/"))
    throw new Error("API_BASE_PATH must start with /");
  const config: AppConfig = {
    appName: nonblank(source.APP_NAME?.trim(), "low-code-workflow-engine-ts"),
    environment: nonblank(source.APP_ENV?.trim(), "development"),
    port,
    apiBasePath,
    erpbridgeAdminEnvironmentAccess: parseBoolean(source.ERPBRIDGE_ADMIN_ENV_ACCESS, false),
    erpbridgeAdminChatActions: parseBoolean(source.ERPBRIDGE_ADMIN_CHAT_ACTIONS, false),
    jwtSecret: nonblank(
      source.JWT_SECRET?.trim(),
      "development-only-change-me",
    ),
    tokenTTLSeconds,
    allowPublicRegistration: parseBoolean(
      source.ALLOW_PUBLIC_REGISTRATION,
      false,
    ),
    toolRegistryPath: resolve(
      root,
      nonblank(
        source.TOOL_REGISTRY_PATH?.trim(),
        "configs/runtime/all_tools_master_registry.json",
      ),
    ),
    ruleRegistryPath: resolve(
      root,
      nonblank(
        source.RULE_REGISTRY_PATH?.trim(),
        "configs/runtime/all_rules_master_registry.json",
      ),
    ),
    storageDriver,
    ...(source.FIRESTORE_CONTENT_FORMAT ? {firestoreContentFormat: source.FIRESTORE_CONTENT_FORMAT} : {}),
    databaseURL: source.DATABASE_URL?.trim() ?? "",
    storageEncryptionKey: source.STORAGE_ENCRYPTION_KEY?.trim() ?? "",
    ...(source.FIRESTORE_PROJECT_ID?.trim() ? { firestoreProjectId: source.FIRESTORE_PROJECT_ID.trim() } : {}),
    ...(source.FIRESTORE_DATABASE_ID?.trim() ? { firestoreDatabaseId: source.FIRESTORE_DATABASE_ID.trim() } : {}),
    ...(source.FIRESTORE_WORKSPACE_ID?.trim() ? { firestoreWorkspaceId: source.FIRESTORE_WORKSPACE_ID.trim() } : {}),
    ...(source.FIRESTORE_KEY_FILE?.trim() ? { firestoreKeyFile: source.FIRESTORE_KEY_FILE.trim() } : {}),
    ...(source.FIRESTORE_KEY_JSON?.trim() ? { firestoreKeyJson: JSON.parse(source.FIRESTORE_KEY_JSON.trim()) as Record<string, unknown> } : {}),
    ...(source.FIRESTORE_ENCRYPTION_KEY?.trim() ? { firestoreEncryptionKey: source.FIRESTORE_ENCRYPTION_KEY.trim() } : {}),
    chatIntentRouting: source.CHAT_INTENT_ROUTING ?? (source.APP_ENV === "test" ? "patterns" : "agent"),
    mcpBaseURL: source.MCP_BASE_URL?.trim() ?? "",
    mcpMode,
    mcpTransport,
    mcpTimeoutMs,
    functionsWriterAdmissionTimeoutMs,
    functionsChatTaskTimeoutMs,
    readWorkerConcurrency,
    readWorkerPerActor,
    readWorkerLeaseMs,
    erpbridgeBaseURL,
    erpbridgeMcpToken,
    erpbridgeMcpTokenReference,
    erpbridgeRoleMap,
    erpbridgeConnections,
    erpbridgePrimaryConnectionId,
    generationBaseURL: source.GENERATION_BASE_URL?.trim() ?? "",
    generationAPIKey: source.GENERATION_API_KEY?.trim() ?? "",
    generationModelPrimary: source.GENERATION_MODEL_PRIMARY?.trim() ?? "",
    generationModelFallback: source.GENERATION_MODEL_FALLBACK?.trim() ?? "",
    generationAdditionalModels: parseAdditionalModelIds(source.GENERATION_ADDITIONAL_MODELS),
    generationTemperature,
    generationTimeoutMs,
    governanceURL: source.GOVERNANCE_URL?.trim() ?? "",
    governanceAPIKey: source.GOVERNANCE_API_KEY?.trim() ?? "",
    governanceTimeoutMs,
    governanceSecondaryURL: source.GOVERNANCE_SECONDARY_URL?.trim() ?? "",
    ...(governanceCacheTTLMs === undefined
      ? {}
      : { governanceCacheTTLms: governanceCacheTTLMs }),
    governanceFallbackPolicyPath: resolve(
      root,
      nonblank(source.GOVERNANCE_FALLBACK_POLICY_PATH?.trim(), "policy/governance_fallback.json"),
    ),
    governanceFallbackLlmApiKey: source.GOVERNANCE_FALLBACK_LLM_API_KEY?.trim() ?? "",
    governanceFallbackLlmModel: nonblank(
      source.GOVERNANCE_FALLBACK_LLM_MODEL?.trim(),
      "deepseek/deepseek-chat-v3-0324",
    ),
    governanceFallbackLlmTimeoutMs,
    policyGateURL: source.POLICY_GATE_URL?.trim() ?? "",
    policyGateAPIKey: source.POLICY_GATE_API_KEY?.trim() ?? "",
    policyGateTimeoutMs,
    pipelineAPIBaseURL: source.PIPELINE_API_BASE_URL?.trim() ?? "",
    pipelineAPIKey: source.PIPELINE_API_KEY?.trim() ?? "",
    pipelineTimeoutMs,
    pipelineWorkspaceId: nonblank(source.PIPELINE_WORKSPACE_ID?.trim(), "lcwe"),
    ragPolicyAPIBaseURL: source.RAG_POLICY_API_BASE_URL?.trim() ?? "",
    ragPolicyAPIKey: source.RAG_POLICY_API_KEY?.trim() ?? "",
    ragPolicyAdminAPIKey: source.RAG_POLICY_ADMIN_API_KEY?.trim() ?? "",
    corsOrigins: nonblank(source.CORS_ORIGINS, "http://localhost:5173")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== ""),
    platformAdminEmail: nonblank(
      source.PLATFORM_ADMIN_EMAIL?.trim(),
      "admin@example.test",
    ),
    platformAdminPassword:
      source.PLATFORM_ADMIN_PASSWORD ?? "change-me-development-password",
  };
  validateConfig(config, options);
  return config;
}

/*******************************************************************************
 * Function: validateConfig
 *
 * Checks application configuration for invalid or incompatible settings.
 ******************************************************************************/
export function validateConfig(config: AppConfig, options: { administratorBootstrap?: "process-startup" | "external" } = {}): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(config.pipelineWorkspaceId ?? "lcwe"))
    throw new Error("PIPELINE_WORKSPACE_ID must be a stable workspace identifier");
  const admissionTimeout = config.functionsWriterAdmissionTimeoutMs ?? 30_000;
  const chatTimeout = config.functionsChatTaskTimeoutMs ?? 180_000;
  if (!Number.isSafeInteger(chatTimeout) || chatTimeout < 1000 || chatTimeout > 240_000)
    throw new Error("FUNCTIONS_CHAT_TASK_TIMEOUT_MS must be between 1000 and 240000 ms");
  if (!Number.isInteger(admissionTimeout) || admissionTimeout < 1000 || admissionTimeout > 60_000)
    throw new Error("FUNCTIONS_WRITER_ADMISSION_TIMEOUT_MS must be between 1000 and 60000 ms");
  if (!["development", "test", "production"].includes(config.environment))
    throw new Error("APP_ENV must be development, test, or production");
  if (config.port < 1 || config.port > 65_535)
    throw new Error("PORT must be between 1 and 65535");
  if (config.jwtSecret.length < 16)
    throw new Error("JWT_SECRET must contain at least 16 characters");
  if ((config.storageDriver === "postgres" || config.storageDriver === "postgres-records") && config.databaseURL === "")
    throw new Error("DATABASE_URL is required when STORAGE_DRIVER=postgres");
  if ((config.storageDriver === "postgres" || config.storageDriver === "postgres-records") && config.storageEncryptionKey === "")
    throw new Error("STORAGE_ENCRYPTION_KEY is required for PostgreSQL storage");
  if ((config.storageDriver === "firestore" || config.storageDriver === "firestore-records") && !config.firestoreProjectId)
    throw new Error("FIRESTORE_PROJECT_ID is required when STORAGE_DRIVER=firestore");
  if (config.storageDriver === "firestore-records") {
    if (config.firestoreContentFormat && !["encrypted-records/v1", "native-fields/v1"].includes(config.firestoreContentFormat)) throw new Error("Invalid FIRESTORE_CONTENT_FORMAT");
    if (!config.firestoreDatabaseId || !config.firestoreWorkspaceId || !config.storageEncryptionKey)
      throw new Error("FIRESTORE_DATABASE_ID, FIRESTORE_WORKSPACE_ID and STORAGE_ENCRYPTION_KEY are required for firestore-records");
    validateFirestoreNamespace({ projectId: config.firestoreProjectId!, databaseId: config.firestoreDatabaseId, workspaceId: config.firestoreWorkspaceId });
    decodeEncryptionKey(config.storageEncryptionKey);
    if (config.firestoreEncryptionKey && config.firestoreEncryptionKey !== config.storageEncryptionKey)
      throw new Error("Ambiguous Firestore encryption keys; firestore-records uses STORAGE_ENCRYPTION_KEY for records and private worker inputs");
  }
  if (
    config.mcpMode === "remote" &&
    config.environment === "production" &&
    config.mcpTransport === "bridge-v1" &&
    config.mcpBaseURL === ""
  )
    throw new Error("MCP_BASE_URL is required in production remote mode");
  if (config.environment === "production" && config.mcpMode === "mock")
    throw new Error("MCP_MODE=mock is refused in production");
  if (config.mcpTransport === "erpbridge-mcp") {
    if (config.erpbridgeConnections.length < 1 || config.erpbridgeConnections.length > 8)
      throw new Error("ERPBridge requires between one and eight backend-owned connections");
    const legacyDefault = config.erpbridgeConnections.length === 1 && config.erpbridgeConnections[0]?.id === "erpbridge-default";
    if (legacyDefault && config.erpbridgeBaseURL === "") throw new Error("ERPBRIDGE_BASE_URL is required when MCP_TRANSPORT=erpbridge-mcp");
    if (legacyDefault && config.erpbridgeMcpToken === "") throw new Error("ERPBRIDGE_MCP_TOKEN or ERPBRIDGE_MCP_TOKEN_ENV is required when MCP_TRANSPORT=erpbridge-mcp");
    if (legacyDefault && Object.keys(config.erpbridgeRoleMap).length === 0) throw new Error("ERPBRIDGE_ROLE_MAP must contain at least one local role mapping");
    if (new Set(config.erpbridgeConnections.map(value => value.id)).size !== config.erpbridgeConnections.length ||
        config.erpbridgeConnections.filter(value => value.primary).length !== 1 || !config.erpbridgeConnections.some(value => value.id === config.erpbridgePrimaryConnectionId && value.primary))
      throw new Error("ERPBridge connections require unique IDs and exactly one configured primary connection");
    for (const connection of config.erpbridgeConnections) {
      let endpoint: URL;
      try { endpoint = new URL(connection.baseURL); } catch { throw new Error(`ERPBridge connection ${connection.id} must use a valid URL`); }
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(connection.id) || !["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/")
        throw new Error(`ERPBridge connection ${connection.id} has an unsupported ID or endpoint`);
      if (config.environment !== "development" && endpoint.protocol !== "https:") throw new Error(`ERPBridge connection ${connection.id} must use HTTPS outside development`);
      if (!connection.mcpToken || /[\r\n]/.test(connection.mcpToken) || connection.mcpToken.length > 16384)
        throw new Error(`ERPBridge connection ${connection.id} requires one supported backend credential`);
      validateRoleMap(connection.roleMap);
      if (Object.keys(connection.roleMap).length === 0) throw new Error(`ERPBridge connection ${connection.id} requires at least one local role mapping`);
    }
  }
  const generationConfigured = [
    config.generationBaseURL,
    config.generationAPIKey,
    config.generationModelPrimary,
    config.generationModelFallback,
  ].some((value) => (value ?? "").trim() !== "") || Boolean(config.generationAdditionalModels?.length);
  if (generationConfigured) {
    if ((config.generationBaseURL ?? "").trim() === "")
      throw new Error(
        "GENERATION_BASE_URL is required when generation is configured",
      );
    if ((config.generationAPIKey ?? "").trim() === "")
      throw new Error(
        "GENERATION_API_KEY is required when generation is configured",
      );
    if ((config.generationModelPrimary ?? "").trim() === "")
      throw new Error(
        "GENERATION_MODEL_PRIMARY is required when generation is configured",
      );
    if (
      (config.generationModelPrimary ?? "").includes(":latest") ||
      (config.generationModelFallback ?? "").includes(":latest")
    )
      throw new Error(
        "generation model IDs must be pinned and cannot use :latest",
      );
  }
  const governanceConfigured =
    [
      config.governanceURL,
      config.governanceAPIKey,
      config.governanceSecondaryURL,
    ].some((value) => (value ?? "").trim() !== "") ||
    config.governanceCacheTTLms !== undefined;
  if (governanceConfigured) {
    if ((config.governanceURL ?? "").trim() === "")
      throw new Error(
        "GOVERNANCE_URL is required when governance is configured",
      );
    if ((config.governanceAPIKey ?? "").trim() === "")
      throw new Error(
        "GOVERNANCE_API_KEY is required when governance is configured",
      );
    if (
      config.governanceCacheTTLms === undefined ||
      config.governanceCacheTTLms <= 0
    )
      throw new Error(
        "GOVERNANCE_CACHE_TTL_MS must be a positive integer when governance is configured",
      );
  }
  if (
    (config.governanceSecondaryURL ?? "").trim() !== "" &&
    (config.governanceURL ?? "").trim() === ""
  )
    throw new Error("GOVERNANCE_SECONDARY_URL requires GOVERNANCE_URL");
  if (
    !Number.isInteger(config.governanceTimeoutMs) ||
    (config.governanceTimeoutMs ?? 0) <= 0
  )
    throw new Error("GOVERNANCE_TIMEOUT_MS must be a positive integer");
  if (!Number.isInteger(config.pipelineTimeoutMs) || (config.pipelineTimeoutMs ?? 0) < 1_000 || (config.pipelineTimeoutMs ?? 0) > 300_000)
    throw new Error("PIPELINE_TIMEOUT_MS must be between 1000 and 300000 ms");
  const pipelineConfigured = Boolean(config.pipelineAPIBaseURL || config.pipelineAPIKey);
  if (pipelineConfigured) {
    if (!config.pipelineAPIBaseURL || !config.pipelineAPIKey)
      throw new Error("PIPELINE_API_BASE_URL and PIPELINE_API_KEY must be configured together");
    let endpoint: URL;
    try { endpoint = new URL(config.pipelineAPIBaseURL); }
    catch { throw new Error("PIPELINE_API_BASE_URL must be a valid service origin"); }
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/")
      throw new Error("PIPELINE_API_BASE_URL must be a credential-free HTTP(S) service origin");
    if (config.environment === "production" && endpoint.protocol !== "https:")
      throw new Error("PIPELINE_API_BASE_URL must use HTTPS in production");
    if (/[\r\n]/.test(config.pipelineAPIKey) || config.pipelineAPIKey.length > 16_384)
      throw new Error("PIPELINE_API_KEY is not a supported backend credential");
  }
  if (config.ragPolicyAPIBaseURL || config.ragPolicyAPIKey) {
    if (!config.ragPolicyAPIBaseURL || !config.ragPolicyAPIKey) throw new Error("RAG_POLICY_API_BASE_URL and RAG_POLICY_API_KEY must be configured together");
    let endpoint: URL;
    try { endpoint = new URL(config.ragPolicyAPIBaseURL); } catch { throw new Error("RAG_POLICY_API_BASE_URL must be a valid service origin"); }
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/" || config.environment === "production" && endpoint.protocol !== "https:")
      throw new Error("RAG_POLICY_API_BASE_URL must be a credential-free service origin, using HTTPS in production");
    if (/[\r\n]/.test(config.ragPolicyAPIKey) || config.ragPolicyAPIKey.length > 16384) throw new Error("RAG_POLICY_API_KEY is not a supported backend credential");
  }
  if (config.ragPolicyAdminAPIKey && (!config.ragPolicyAPIBaseURL || /[\r\n]/.test(config.ragPolicyAdminAPIKey) || config.ragPolicyAdminAPIKey.length > 16384))
    throw new Error("RAG_POLICY_ADMIN_API_KEY requires the backend RAG connection and a supported server credential");
  if (
    config.environment === "production" &&
    options.administratorBootstrap !== "external" &&
    config.platformAdminPassword === "change-me-development-password"
  )
    throw new Error("PLATFORM_ADMIN_PASSWORD must be configured in production");
  if (config.environment === "production") validateProductionReleaseConfig(config, options.administratorBootstrap !== "external");
}

function validateProductionReleaseConfig(config: AppConfig, bootstrapAdministrator: boolean): void {
  if (config.storageDriver !== "firestore-records")
    throw new Error("Production requires STORAGE_DRIVER=firestore-records; memory, SQL and legacy Firestore are not the selected qualified release store");
  if (config.firestoreKeyFile || config.firestoreKeyJson)
    throw new Error("Production Firestore credentials must use workload identity/ADC; key files and inline key JSON are refused");
  if (config.mcpMode !== "remote" || config.mcpTransport !== "erpbridge-mcp")
    throw new Error("Production requires the reviewed remote ERPBridge MCP transport; legacy bridge-v1 and mock fallback are refused");
  if (!isMcpConfigured(config))
    throw new Error("Production requires at least one completely configured ERPBridge connection");
  if (Buffer.byteLength(config.jwtSecret, "utf8") < 32 || config.jwtSecret === "development-only-change-me")
    throw new Error("Production JWT_SECRET must contain at least 32 bytes and cannot use the development default");
  if (bootstrapAdministrator && config.platformAdminEmail === "admin@example.test")
    throw new Error("PLATFORM_ADMIN_EMAIL must be explicitly configured in production");
  if (bootstrapAdministrator && Buffer.byteLength(config.platformAdminPassword, "utf8") < 16)
    throw new Error("PLATFORM_ADMIN_PASSWORD must contain at least 16 bytes in production");
  if (config.corsOrigins.length < 1)
    throw new Error("Production requires at least one exact HTTPS CORS origin");
  for (const origin of config.corsOrigins) validateProductionOrigin(origin, "CORS_ORIGINS");
  for (const [name, value] of [
    ["GENERATION_BASE_URL", config.generationBaseURL],
    ["GOVERNANCE_URL", config.governanceURL],
    ["GOVERNANCE_SECONDARY_URL", config.governanceSecondaryURL],
    ["POLICY_GATE_URL", config.policyGateURL],
    ["PIPELINE_API_BASE_URL", config.pipelineAPIBaseURL],
    ["RAG_POLICY_API_BASE_URL", config.ragPolicyAPIBaseURL],
  ] as const) {
    if ((value ?? "") !== "") validateProductionServiceURL(value!, name);
  }
}

function parseProductionURL(value: string, name: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${name} must contain a valid HTTPS URL in production`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error(`${name} must contain a credential-free HTTPS URL in production`);
  return url;
}

function validateProductionOrigin(value: string, name: string): void {
  const url = parseProductionURL(value, name);
  if (url.pathname !== "/" || url.search)
    throw new Error(`${name} entries must be exact HTTPS origins without a path, query, credentials, or fragment`);
}

function validateProductionServiceURL(value: string, name: string): void {
  const url = parseProductionURL(value, name);
  if (url.search)
    throw new Error(`${name} cannot contain a query string in production`);
}

/*******************************************************************************
 * Function: parseInteger
 *
 * Parses an integer setting or returns its fallback when absent.
 ******************************************************************************/
function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^-?\d+$/.test(value.trim()))
    throw new Error(`${name} must be an integer`);
  return Number.parseInt(value, 10);
}

/*******************************************************************************
 * Function: parseOptionalInteger
 *
 * Parses an optional integer setting and rejects invalid numeric text.
 ******************************************************************************/
function parseOptionalInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^-?\d+$/.test(value.trim()))
    throw new Error(`${name} must be an integer`);
  return Number.parseInt(value, 10);
}

/*******************************************************************************
 * Function: parseBoolean
 *
 * Parses a boolean setting or returns its fallback when absent.
 ******************************************************************************/
function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  throw new Error(`invalid boolean ${JSON.stringify(value)}`);
}

/*******************************************************************************
 * Function: parseNumber
 *
 * Parses a finite numeric setting or returns its fallback when absent.
 ******************************************************************************/
function parseNumber(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new Error(`${name} must be a finite number`);
  return parsed;
}

/*******************************************************************************
 * Function: nonblank
 *
 * Returns the fallback when the supplied value is undefined or empty.
 ******************************************************************************/
function nonblank(value: string | undefined, fallback: string): string {
  return value === undefined || value === "" ? fallback : value;
}

const knownLocalRoles = new Set([
  "Platform Admin",
  "System Admin",
  "Workflow Builder",
  "Client",
]);

/*******************************************************************************
 * Function: resolveToken
 *
 * Resolves a direct token or its selected environment variable.
 ******************************************************************************/
function resolveToken(
  env: NodeJS.ProcessEnv,
  directValue: string | undefined,
  tokenEnv: string | undefined,
): string {
  const direct = directValue?.trim() ?? "";
  const selected = tokenEnv?.trim() ?? "";
  if (direct !== "" && selected !== "")
    throw new Error(
      "configure exactly one of ERPBRIDGE_MCP_TOKEN and ERPBRIDGE_MCP_TOKEN_ENV",
    );
  if (selected === "") return direct;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(selected))
    throw new Error(
      "ERPBRIDGE_MCP_TOKEN_ENV must be a valid environment variable name",
    );
  return env[selected]?.trim() ?? "";
}

function parseErpbridgeConnections(env: NodeJS.ProcessEnv, source: z.infer<typeof environmentSchema>): ErpbridgeConnectionConfig[] {
  const catalogText = source.ERPBRIDGE_CONNECTIONS_JSON?.trim() ?? "";
  if (catalogText === "") {
    const token = resolveToken(env, source.ERPBRIDGE_MCP_TOKEN, source.ERPBRIDGE_MCP_TOKEN_ENV);
    return [{ id: "erpbridge-default", baseURL: source.ERPBRIDGE_BASE_URL?.trim() ?? "", mcpToken: token,
      tokenReference: source.ERPBRIDGE_MCP_TOKEN_ENV?.trim() || "ERPBRIDGE_MCP_TOKEN", roleMap: parseRoleMap(source.ERPBRIDGE_ROLE_MAP), primary: true }];
  }
  if ([source.ERPBRIDGE_BASE_URL, source.ERPBRIDGE_MCP_TOKEN, source.ERPBRIDGE_MCP_TOKEN_ENV, source.ERPBRIDGE_ROLE_MAP].some(value => (value?.trim() ?? "") !== ""))
    throw new Error("ERPBRIDGE_CONNECTIONS_JSON cannot be combined with legacy single-connection ERPBridge settings");
  let decoded: unknown;
  try { decoded = JSON.parse(catalogText); } catch { throw new Error("ERPBRIDGE_CONNECTIONS_JSON must be valid JSON"); }
  if (!Array.isArray(decoded) || decoded.length < 1 || decoded.length > 8) throw new Error("ERPBRIDGE_CONNECTIONS_JSON must contain one to eight connections");
  const primaryId = source.ERPBRIDGE_PRIMARY_CONNECTION_ID?.trim() ?? "";
  if (decoded.length > 1 && !primaryId) throw new Error("ERPBRIDGE_PRIMARY_CONNECTION_ID is required when multiple ERPBridge connections are configured");
  const values = decoded.map((raw, index): ErpbridgeConnectionConfig => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`ERPBridge connection ${index + 1} must be an object`);
    const record = raw as Record<string, unknown>, allowed = new Set(["id", "baseURL", "tokenEnv", "roleMap"]);
    if (Object.keys(record).some(key => !allowed.has(key)) || typeof record.id !== "string" || typeof record.baseURL !== "string" || typeof record.tokenEnv !== "string" ||
        !record.roleMap || typeof record.roleMap !== "object" || Array.isArray(record.roleMap)) throw new Error(`ERPBridge connection ${index + 1} has unsupported fields`);
    const id = record.id.trim(), tokenReference = record.tokenEnv.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenReference)) throw new Error(`ERPBridge connection ${id || index + 1} tokenEnv must name one environment variable`);
    const mcpToken = env[tokenReference]?.trim() ?? "";
    return { id, baseURL: record.baseURL.trim(), mcpToken, tokenReference, roleMap: parseRoleMap(JSON.stringify(record.roleMap)), primary: id === (primaryId || String(record.id).trim()) };
  });
  if (!primaryId && values.length === 1) values[0]!.primary = true;
  if (primaryId && !values.some(value => value.id === primaryId)) throw new Error("ERPBRIDGE_PRIMARY_CONNECTION_ID must identify one configured connection");
  return values;
}

/*******************************************************************************
 * Function: parseRoleMap
 *
 * Parses configured local-to-ERPBridge role mappings.
 ******************************************************************************/
function parseRoleMap(value: string | undefined): Record<string, string> {
  const raw = value?.trim() ?? "";
  if (raw === "") return {};
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error("ERPBRIDGE_ROLE_MAP must be valid JSON");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("ERPBRIDGE_ROLE_MAP must be a JSON object");
  }
  const map: Record<string, string> = {};
  for (const [localRole, remoteRoleValue] of Object.entries(decoded)) {
    if (!knownLocalRoles.has(localRole))
      throw new Error(
        `ERPBRIDGE_ROLE_MAP contains an unrecognized local role ${JSON.stringify(localRole)}`,
      );
    if (typeof remoteRoleValue !== "string" || remoteRoleValue.trim() === "")
      throw new Error(
        `ERPBRIDGE_ROLE_MAP target for ${JSON.stringify(localRole)} must be nonblank`,
      );
    const remoteRole = remoteRoleValue.trim();
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(remoteRole))
      throw new Error("ERPBRIDGE_ROLE_MAP target must match the verified ERPBridge role format");
    if (
      Object.values(map).some(
        (item) => item.toLowerCase() === remoteRole.toLowerCase(),
      )
    )
      throw new Error(
        `ERPBRIDGE_ROLE_MAP contains a duplicate target role ${JSON.stringify(remoteRole)}`,
      );
    map[localRole] = remoteRole;
  }
  return map;
}

/** Additional environment choices are selectable, not automatic fallbacks or
 * evidence of provider connectivity. Preserve order and reject unsafe aliases. */
export function parseAdditionalModelIds(value: string | undefined): string[] {
  const raw = value?.trim() ?? "";
  if (!raw) return [];
  if (raw.length > 16448) throw new Error("GENERATION_ADDITIONAL_MODELS exceeds the supported catalog size");
  const models = raw.split(",").map(model => model.trim());
  if (models.length > 64 || models.some(model => !model || model.length > 256 || /\s/.test(model) || model.includes(":latest")))
    throw new Error("GENERATION_ADDITIONAL_MODELS requires at most 64 nonblank pinned model IDs, separated by commas");
  return [...new Set(models)];
}

/*******************************************************************************
 * Function: validateRoleMap
 *
 * Checks role mappings for recognized local roles and valid remote targets.
 ******************************************************************************/
function validateRoleMap(map: Record<string, string>): void {
  for (const [localRole, remoteRole] of Object.entries(map)) {
    if (!knownLocalRoles.has(localRole))
      throw new Error(
        `ERPBRIDGE_ROLE_MAP contains an unrecognized local role ${JSON.stringify(localRole)}`,
      );
    if (remoteRole.trim() === "")
      throw new Error(
        `ERPBRIDGE_ROLE_MAP target for ${JSON.stringify(localRole)} must be nonblank`,
      );
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(remoteRole))
      throw new Error("ERPBRIDGE_ROLE_MAP target must match the verified ERPBridge role format");
  }
  const targets = Object.values(map).map((role) => role.toLowerCase());
  if (new Set(targets).size !== targets.length)
    throw new Error("ERPBRIDGE_ROLE_MAP contains duplicate target roles");
}
