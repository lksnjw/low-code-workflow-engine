import { resolve } from "node:path";
import { z } from "zod";

const environmentSchema = z
  .object({
    APP_NAME: z.string().optional(),
    APP_ENV: z.string().optional(),
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
    ERPBRIDGE_BASE_URL: z.string().optional(),
    ERPBRIDGE_MCP_TOKEN: z.string().optional(),
    ERPBRIDGE_MCP_TOKEN_ENV: z.string().optional(),
    ERPBRIDGE_ROLE_MAP: z.string().optional(),
    GENERATION_BASE_URL: z.string().optional(),
    GENERATION_API_KEY: z.string().optional(),
    GENERATION_MODEL_PRIMARY: z.string().optional(),
    GENERATION_MODEL_FALLBACK: z.string().optional(),
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
    FIRESTORE_KEY_FILE: z.string().optional(),
    FIRESTORE_KEY_JSON: z.string().optional(),
    FIRESTORE_ENCRYPTION_KEY: z.string().optional(),
    POLICY_GATE_URL: z.string().optional(),
    POLICY_GATE_API_KEY: z.string().optional(),
    POLICY_GATE_TIMEOUT_MS: z.string().optional(),
    CORS_ORIGINS: z.string().optional(),
    PLATFORM_ADMIN_EMAIL: z.string().optional(),
    PLATFORM_ADMIN_PASSWORD: z.string().optional(),
  })
  .passthrough();

export type MCPTransport = "bridge-v1" | "erpbridge-mcp";

export type AppConfig = {
  appName: string;
  environment: string;
  port: number;
  apiBasePath: string;
  jwtSecret: string;
  tokenTTLSeconds: number;
  allowPublicRegistration: boolean;
  toolRegistryPath: string;
  ruleRegistryPath: string;
  storageDriver: "memory" | "postgres" | "firestore";
  firestoreProjectId?: string;
  firestoreKeyFile?: string;
  firestoreKeyJson?: Record<string, unknown>;
  firestoreEncryptionKey?: string;
  databaseURL: string;
  storageEncryptionKey: string;
  mcpBaseURL: string;
  mcpMode: "remote" | "mock";
  mcpTransport: MCPTransport;
  mcpTimeoutMs: number;
  erpbridgeBaseURL: string;
  erpbridgeMcpToken: string;
  erpbridgeRoleMap: Record<string, string>;
  generationBaseURL?: string;
  generationAPIKey?: string;
  generationModelPrimary?: string;
  generationModelFallback?: string;
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
  corsOrigins: string[];
  platformAdminEmail: string;
  platformAdminPassword: string;
};

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  root = process.cwd(),
): AppConfig {
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
  const mcpTransport = nonblank(
    source.MCP_TRANSPORT?.trim().toLowerCase(),
    "bridge-v1",
  ) as AppConfig["mcpTransport"];
  if (mcpTransport !== "bridge-v1" && mcpTransport !== "erpbridge-mcp")
    throw new Error(
      `unsupported MCP_TRANSPORT ${JSON.stringify(mcpTransport)} (allowed values: bridge-v1 or erpbridge-mcp)`,
    );
  const erpbridgeBaseURL = source.ERPBRIDGE_BASE_URL?.trim() ?? "";
  const erpbridgeMcpToken =
    mcpTransport === "erpbridge-mcp"
      ? resolveToken(
          env,
          source.ERPBRIDGE_MCP_TOKEN,
          source.ERPBRIDGE_MCP_TOKEN_ENV,
        )
      : "";
  const erpbridgeRoleMap =
    mcpTransport === "erpbridge-mcp"
      ? parseRoleMap(source.ERPBRIDGE_ROLE_MAP)
      : {};
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
  const storageDriver = nonblank(
    source.STORAGE_DRIVER?.trim().toLowerCase(),
    "memory",
  ) as AppConfig["storageDriver"];
  if (storageDriver !== "memory" && storageDriver !== "postgres" && storageDriver !== "firestore")
    throw new Error(
      `unsupported STORAGE_DRIVER ${JSON.stringify(storageDriver)} (allowed values: memory, postgres, or firestore)`,
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
    databaseURL: source.DATABASE_URL?.trim() ?? "",
    storageEncryptionKey: source.STORAGE_ENCRYPTION_KEY?.trim() ?? "",
    ...(source.FIRESTORE_PROJECT_ID?.trim() ? { firestoreProjectId: source.FIRESTORE_PROJECT_ID.trim() } : {}),
    ...(source.FIRESTORE_KEY_FILE?.trim() ? { firestoreKeyFile: source.FIRESTORE_KEY_FILE.trim() } : {}),
    ...(source.FIRESTORE_KEY_JSON?.trim() ? { firestoreKeyJson: JSON.parse(source.FIRESTORE_KEY_JSON.trim()) as Record<string, unknown> } : {}),
    ...(source.FIRESTORE_ENCRYPTION_KEY?.trim() ? { firestoreEncryptionKey: source.FIRESTORE_ENCRYPTION_KEY.trim() } : {}),
    mcpBaseURL: source.MCP_BASE_URL?.trim() ?? "",
    mcpMode,
    mcpTransport,
    mcpTimeoutMs,
    erpbridgeBaseURL,
    erpbridgeMcpToken,
    erpbridgeRoleMap,
    generationBaseURL: source.GENERATION_BASE_URL?.trim() ?? "",
    generationAPIKey: source.GENERATION_API_KEY?.trim() ?? "",
    generationModelPrimary: source.GENERATION_MODEL_PRIMARY?.trim() ?? "",
    generationModelFallback: source.GENERATION_MODEL_FALLBACK?.trim() ?? "",
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
  validateConfig(config);
  return config;
}

export function validateConfig(config: AppConfig): void {
  if (config.port < 1 || config.port > 65_535)
    throw new Error("PORT must be between 1 and 65535");
  if (config.jwtSecret.length < 16)
    throw new Error("JWT_SECRET must contain at least 16 characters");
  if (config.storageDriver === "postgres" && config.databaseURL === "")
    throw new Error("DATABASE_URL is required when STORAGE_DRIVER=postgres");
  if (config.storageDriver === "postgres" && config.storageEncryptionKey === "")
    throw new Error("STORAGE_ENCRYPTION_KEY is required for PostgreSQL storage");
  if (config.storageDriver === "firestore" && !config.firestoreProjectId)
    throw new Error("FIRESTORE_PROJECT_ID is required when STORAGE_DRIVER=firestore");
  if (
    config.mcpMode === "remote" &&
    config.environment === "production" &&
    config.mcpBaseURL === ""
  )
    throw new Error("MCP_BASE_URL is required in production remote mode");
  if (config.environment === "production" && config.mcpMode === "mock")
    throw new Error("MCP_MODE=mock is refused in production");
  if (config.mcpTransport === "erpbridge-mcp") {
    if (config.erpbridgeBaseURL === "")
      throw new Error(
        "ERPBRIDGE_BASE_URL is required when MCP_TRANSPORT=erpbridge-mcp",
      );
    let endpoint: URL;
    try {
      endpoint = new URL(config.erpbridgeBaseURL);
    } catch {
      throw new Error("ERPBRIDGE_BASE_URL must be a valid URL");
    }
    if (config.environment !== "development" && endpoint.protocol !== "https:")
      throw new Error("ERPBRIDGE_BASE_URL must use HTTPS outside development");
    if (config.erpbridgeMcpToken === "")
      throw new Error(
        "ERPBRIDGE_MCP_TOKEN or ERPBRIDGE_MCP_TOKEN_ENV is required when MCP_TRANSPORT=erpbridge-mcp",
      );
    validateRoleMap(config.erpbridgeRoleMap);
    if (Object.keys(config.erpbridgeRoleMap).length === 0)
      throw new Error(
        "ERPBRIDGE_ROLE_MAP must contain at least one local role mapping",
      );
  }
  const generationConfigured = [
    config.generationBaseURL,
    config.generationAPIKey,
    config.generationModelPrimary,
    config.generationModelFallback,
  ].some((value) => (value ?? "").trim() !== "");
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
  if (
    config.environment === "production" &&
    config.platformAdminPassword === "change-me-development-password"
  )
    throw new Error("PLATFORM_ADMIN_PASSWORD must be configured in production");
}

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

function parseOptionalInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^-?\d+$/.test(value.trim()))
    throw new Error(`${name} must be an integer`);
  return Number.parseInt(value, 10);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  throw new Error(`invalid boolean ${JSON.stringify(value)}`);
}

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

function nonblank(value: string | undefined, fallback: string): string {
  return value === undefined || value === "" ? fallback : value;
}

const knownLocalRoles = new Set([
  "Platform Admin",
  "System Admin",
  "Workflow Builder",
  "Client",
]);

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

function parseRoleMap(value: string | undefined): Record<string, string> {
  const raw = value?.trim() ?? "";
  if (raw === "") return {};
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    console.warn("[config] ERPBRIDGE_ROLE_MAP is not valid JSON — role mapping disabled");
    return {};
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    console.warn("[config] ERPBRIDGE_ROLE_MAP must be a JSON object — role mapping disabled");
    return {};
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
  }
  const targets = Object.values(map).map((role) => role.toLowerCase());
  if (new Set(targets).size !== targets.length)
    throw new Error("ERPBRIDGE_ROLE_MAP contains duplicate target roles");
}
