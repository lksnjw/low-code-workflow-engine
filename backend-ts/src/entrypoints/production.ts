import { dirname, resolve } from "node:path";
import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { loadConfig } from "../config/config.js";
import { buildApp } from "../http/app.js";
import {
  RegistryService,
  ensureRuntimeRegistries,
} from "../registry/service.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { Repository } from "../repository/store.js";
import { Executor } from "../runner/executor.js";
import { GenericMCPTool } from "../tools/generic-mcp-tool.js";
import {
  createErpbridgeMcpSession,
  type ErpbridgeMcpSession,
} from "../tools/erpbridge-mcp-client.js";
import {
  createGovernedMCPClient,
  type GovernedMCPClient,
} from "../tools/mcp-client.js";
import { ToolRegistry } from "../tools/registry.js";
import { RegistryValidator } from "../validator/registry-validator.js";
import { hashPassword } from "../authn/password.js";
import { PostgresPersistence } from "../storage/postgres.js";
import {
  ProviderRuntime,
  type RuntimeProviderConfiguration,
} from "../providers/runtime.js";
import { SynthesisService } from "../synthesis/service.js";
import { GovernanceAdapter } from "../governance/adapter.js";
import { GovernanceService } from "../governance/service.js";
import { GovernedValidationGate } from "../governance/gate.js";
import { LlmPolicyFallback } from "../governance/llm-fallback.js";

const root = process.cwd();
const config = loadConfig(process.env, root);
await ensureRuntimeRegistries({
  toolPath: config.toolRegistryPath,
  rulePath: config.ruleRegistryPath,
  frozenToolPath: resolve(
    root,
    "fixtures/parity/http/runtime/all_tools_master_registry.json",
  ),
  frozenRulePath: resolve(
    root,
    "fixtures/parity/http/runtime/all_rules_master_registry.json",
  ),
});
await ensureRuntimeContext(
  resolve(root, "fixtures/parity/http/runtime/registry_context.md"),
  resolve(dirname(config.toolRegistryPath), "registry_context.md"),
);
const registries = await RegistryService.load(
  config.toolRegistryPath,
  config.ruleRegistryPath,
);
const persistence =
  config.storageDriver === "postgres"
    ? await PostgresPersistence.open(
        config.databaseURL,
        config.storageEncryptionKey,
      )
    : null;
const repository = await Repository.open(persistence);
await bootstrapAdministrator(
  repository,
  config.platformAdminEmail,
  config.platformAdminPassword,
);
await reconcileInterruptedExecutions(repository);
const validator = new RegistryValidator(registries, repository);
const legacyMcp =
  config.mcpTransport === "bridge-v1"
    ? createGovernedMCPClient({
        baseURL: config.mcpBaseURL,
        timeoutMs: config.mcpTimeoutMs,
        mode: config.mcpMode,
        validator,
      })
    : null;
const erpbridgeSession: ErpbridgeMcpSession | null =
  config.mcpTransport === "erpbridge-mcp"
    ? await createErpbridgeMcpSession({
        baseURL: config.erpbridgeBaseURL,
        token: config.erpbridgeMcpToken,
        timeoutMs: config.mcpTimeoutMs,
        validator,
      })
    : null;
const clientFor = (definition: ToolDefinition): GovernedMCPClient =>
  erpbridgeSession === null
    ? legacyMcp!
    : erpbridgeSession.clientFor(definition);
const toolRegistry = new ToolRegistry();
for (const definition of registries.snapshot().tools)
  toolRegistry.register(
    new GenericMCPTool(
      definition.name,
      definition.description,
      clientFor(definition),
    ),
  );
registries.onToolUpsert((definition) => {
  if (!toolRegistry.has(definition.name))
    toolRegistry.register(
      new GenericMCPTool(
        definition.name,
        definition.description,
        clientFor(definition),
      ),
    );
});
const executor = new Executor(toolRegistry, validator);
const providerRuntime = new ProviderRuntime(repository, executor);
const generationConfiguration = staticProviderConfiguration();
if (generationConfiguration !== null)
  providerRuntime.activate(generationConfiguration);
const governancePrimary =
  (config.governanceURL ?? "") === ""
    ? null
    : new GovernanceAdapter({
        url: config.governanceURL!,
        apiKey: config.governanceAPIKey ?? "",
        timeoutMs: config.governanceTimeoutMs ?? 10_000,
        source: "primary",
      });
const governanceSecondary =
  (config.governanceSecondaryURL ?? "") === ""
    ? null
    : new GovernanceAdapter({
        url: config.governanceSecondaryURL!,
        apiKey: config.governanceAPIKey ?? "",
        timeoutMs: config.governanceTimeoutMs ?? 10_000,
        source: "secondary",
      });
const governanceLlmFallback = new LlmPolicyFallback({
  openrouterApiKey: config.governanceFallbackLlmApiKey,
  model: config.governanceFallbackLlmModel,
  policyPath: config.governanceFallbackPolicyPath,
  timeoutMs: config.governanceFallbackLlmTimeoutMs,
});
const governance = new GovernanceService(
  governancePrimary,
  governanceSecondary,
  config.governanceCacheTTLms ?? 0,
  registries,
  repository,
  governanceLlmFallback,
);
await governance.initialize();
const validationGate = new GovernedValidationGate(
  governance,
  validator,
  registries,
  repository,
);
const synthesis = new SynthesisService(
  providerRuntime,
  registries,
  validator,
  validationGate,
);
const app = await buildApp({
  config,
  repository,
  registries,
  validator,
  validationGate,
  executor,
  providerRuntime,
  synthesis,
  contextAvailable: true,
  ...(erpbridgeSession !== null ? { erpbridgeSession } : {}),
});
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  await erpbridgeSession?.close();
  await repository.close();
};
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
await app.listen({ host: "0.0.0.0", port: config.port });

async function bootstrapAdministrator(
  repository: Repository,
  email: string,
  password: string,
): Promise<void> {
  const existing = await repository.read((state) =>
    Object.values(state.users).find(
      (user) => user.email.toLowerCase() === email.toLowerCase(),
    ),
  );
  if (existing !== undefined) return;
  const passwordHash = await hashPassword(password);
  await repository.mutate((state) => {
    state.counter += 1;
    const id = `usr_${state.counter}_admin`;
    state.users[id] = {
      id,
      name: "Platform Admin",
      email: email.toLowerCase(),
      roleId: "role_admin",
      permissionOverrides: [],
      status: "Active",
      initials: "PA",
      departmentId: null,
      lastLoginAt: null,
      createdAt: new Date().toISOString(),
    };
    state.passwordHashes[id] = passwordHash;
  });
}

async function reconcileInterruptedExecutions(
  repository: Repository,
): Promise<void> {
  await repository.mutate((state) => {
    const completedAt = new Date().toISOString();
    for (const execution of Object.values(state.executions)) {
      if (execution.status !== "RUNNING") continue;
      execution.status = "FAILED";
      execution.completedAt = completedAt;
      execution.durationMs = Math.max(
        0,
        new Date(completedAt).getTime() -
          new Date(execution.startedAt).getTime(),
      );
      const logs = state.executionLogs[execution.id] ?? [];
      logs.push({
        id: `log_${logs.length + 1}`,
        executionId: execution.id,
        timestamp: completedAt,
        level: "error",
        nodeId: "system",
        message: "Execution was interrupted by a process restart",
        metadata: { reason: "process_restarted_mid_run" },
      });
      state.executionLogs[execution.id] = logs;
    }
  });
}

async function ensureRuntimeContext(
  source: string,
  target: string,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function staticProviderConfiguration(): RuntimeProviderConfiguration | null {
  const baseURL = config.generationBaseURL ?? "";
  if (baseURL === "") return null;
  return {
    id: "provider_static",
    name: "Environment provider",
    type: "openai_compatible",
    baseURL,
    apiKey: config.generationAPIKey ?? "",
    model: config.generationModelPrimary ?? "",
    fallbackModel: config.generationModelFallback ?? "",
    temperature: config.generationTemperature ?? 0,
    timeoutMs: config.generationTimeoutMs ?? 30_000,
  };
}
