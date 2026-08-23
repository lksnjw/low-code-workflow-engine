import { resolve } from "node:path";
import { z } from "zod";

const environmentSchema = z.object({
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
  MCP_TIMEOUT_MS: z.string().optional(),
  GENERATION_BASE_URL: z.string().optional(),
  GENERATION_API_KEY: z.string().optional(),
  GENERATION_MODEL_PRIMARY: z.string().optional(),
  GENERATION_MODEL_FALLBACK: z.string().optional(),
  GENERATION_TEMPERATURE: z.string().optional(),
  GENERATION_TIMEOUT_MS: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),
  PLATFORM_ADMIN_EMAIL: z.string().optional(),
  PLATFORM_ADMIN_PASSWORD: z.string().optional(),
}).passthrough();

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
  storageDriver: "memory" | "postgres";
  databaseURL: string;
  storageEncryptionKey: string;
  mcpBaseURL: string;
  mcpMode: "remote" | "mock";
  mcpTimeoutMs: number;
  generationBaseURL?: string;
  generationAPIKey?: string;
  generationModelPrimary?: string;
  generationModelFallback?: string;
  generationTemperature?: number;
  generationTimeoutMs?: number;
  corsOrigins: string[];
  platformAdminEmail: string;
  platformAdminPassword: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env, root = process.cwd()): AppConfig {
  const source = environmentSchema.parse(env);
  const port = parseInteger(source.PORT, 8081, "PORT");
  const tokenTTLSeconds = parseInteger(source.TOKEN_TTL_SECONDS, 3600, "TOKEN_TTL_SECONDS");
  const mcpTimeoutMs = parseInteger(source.MCP_TIMEOUT_MS, 30_000, "MCP_TIMEOUT_MS");
  const generationTimeoutMs = parseInteger(source.GENERATION_TIMEOUT_MS, 30_000, "GENERATION_TIMEOUT_MS");
  const generationTemperature = parseNumber(source.GENERATION_TEMPERATURE, 0, "GENERATION_TEMPERATURE");
  const storageDriver = nonblank(source.STORAGE_DRIVER?.trim().toLowerCase(), "memory") as AppConfig["storageDriver"];
  if (storageDriver !== "memory" && storageDriver !== "postgres") throw new Error(`unsupported STORAGE_DRIVER ${JSON.stringify(storageDriver)} (allowed values: memory or postgres)`);
  const mcpMode = nonblank(source.MCP_MODE?.trim().toLowerCase(), "remote") as AppConfig["mcpMode"];
  if (mcpMode !== "remote" && mcpMode !== "mock") throw new Error(`unsupported MCP_MODE ${JSON.stringify(mcpMode)}`);
  const apiBasePath = nonblank(source.API_BASE_PATH?.trim(), "/api");
  if (!apiBasePath.startsWith("/")) throw new Error("API_BASE_PATH must start with /");
  const config: AppConfig = {
    appName: nonblank(source.APP_NAME?.trim(), "low-code-workflow-engine-ts"),
    environment: nonblank(source.APP_ENV?.trim(), "development"),
    port,
    apiBasePath,
    jwtSecret: nonblank(source.JWT_SECRET?.trim(), "development-only-change-me"),
    tokenTTLSeconds,
    allowPublicRegistration: parseBoolean(source.ALLOW_PUBLIC_REGISTRATION, false),
    toolRegistryPath: resolve(root, nonblank(source.TOOL_REGISTRY_PATH?.trim(), "configs/runtime/all_tools_master_registry.json")),
    ruleRegistryPath: resolve(root, nonblank(source.RULE_REGISTRY_PATH?.trim(), "configs/runtime/all_rules_master_registry.json")),
    storageDriver,
    databaseURL: source.DATABASE_URL?.trim() ?? "",
    storageEncryptionKey: source.STORAGE_ENCRYPTION_KEY?.trim() ?? "",
    mcpBaseURL: source.MCP_BASE_URL?.trim() ?? "",
    mcpMode,
    mcpTimeoutMs,
    generationBaseURL: source.GENERATION_BASE_URL?.trim() ?? "",
    generationAPIKey: source.GENERATION_API_KEY?.trim() ?? "",
    generationModelPrimary: source.GENERATION_MODEL_PRIMARY?.trim() ?? "",
    generationModelFallback: source.GENERATION_MODEL_FALLBACK?.trim() ?? "",
    generationTemperature,
    generationTimeoutMs,
    corsOrigins: nonblank(source.CORS_ORIGINS, "http://localhost:5173").split(",").map((item) => item.trim()).filter((item) => item !== ""),
    platformAdminEmail: nonblank(source.PLATFORM_ADMIN_EMAIL?.trim(), "admin@example.test"),
    platformAdminPassword: source.PLATFORM_ADMIN_PASSWORD ?? "change-me-development-password",
  };
  validateConfig(config);
  return config;
}

export function validateConfig(config: AppConfig): void {
  if (config.port < 1 || config.port > 65_535) throw new Error("PORT must be between 1 and 65535");
  if (config.jwtSecret.length < 16) throw new Error("JWT_SECRET must contain at least 16 characters");
  if (config.storageDriver === "postgres" && config.databaseURL === "") throw new Error("DATABASE_URL is required when STORAGE_DRIVER=postgres");
  if (config.storageDriver === "postgres" && config.storageEncryptionKey === "") throw new Error("STORAGE_ENCRYPTION_KEY is required for PostgreSQL storage");
  if (config.mcpMode === "remote" && config.environment === "production" && config.mcpBaseURL === "") throw new Error("MCP_BASE_URL is required in production remote mode");
  if (config.environment === "production" && config.mcpMode === "mock") throw new Error("MCP_MODE=mock is refused in production");
  const generationConfigured = [config.generationBaseURL, config.generationAPIKey, config.generationModelPrimary, config.generationModelFallback].some((value) => (value ?? "").trim() !== "");
  if (generationConfigured) {
    if ((config.generationBaseURL ?? "").trim() === "") throw new Error("GENERATION_BASE_URL is required when generation is configured");
    if ((config.generationAPIKey ?? "").trim() === "") throw new Error("GENERATION_API_KEY is required when generation is configured");
    if ((config.generationModelPrimary ?? "").trim() === "") throw new Error("GENERATION_MODEL_PRIMARY is required when generation is configured");
    if ((config.generationModelPrimary ?? "").includes(":latest") || (config.generationModelFallback ?? "").includes(":latest")) throw new Error("generation model IDs must be pinned and cannot use :latest");
  }
  if (config.environment === "production" && config.platformAdminPassword === "change-me-development-password") throw new Error("PLATFORM_ADMIN_PASSWORD must be configured in production");
}

function parseInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^-?\d+$/.test(value.trim())) throw new Error(`${name} must be an integer`);
  return Number.parseInt(value, 10);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  throw new Error(`invalid boolean ${JSON.stringify(value)}`);
}

function parseNumber(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}

function nonblank(value: string | undefined, fallback: string): string {
  return value === undefined || value === "" ? fallback : value;
}
