import { randomBytes } from "node:crypto";
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
import { ToolRegistry, createDispatchIdentity } from "../tools/registry.js";
import { RegistryValidator } from "../validator/registry-validator.js";
import { hashPassword } from "../authn/password.js";
import { PostgresPersistence } from "../storage/postgres.js";
import { FirestorePersistence } from "../storage/firestore.js";
import {
  ProviderRuntime,
  type RuntimeProviderConfiguration,
} from "../providers/runtime.js";
import { SynthesisService } from "../synthesis/service.js";
import { GovernanceAdapter } from "../governance/adapter.js";
import { GovernanceService } from "../governance/service.js";
import { GovernedValidationGate } from "../governance/gate.js";
import { LlmPolicyFallback } from "../governance/llm-fallback.js";
import { PolicyGateClient } from "../governance/policy-gate-client.js";
import { runActionLoop } from "../agent/action-loop.js";
import { discoverTools } from "../agent/tool-discovery.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";

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
    ? await PostgresPersistence.open(config.databaseURL, config.storageEncryptionKey)
    : config.storageDriver === "firestore"
      ? await FirestorePersistence.open({
          projectId: config.firestoreProjectId!,
          ...(config.firestoreKeyFile ? { keyFilename: config.firestoreKeyFile } : {}),
          ...(config.firestoreKeyJson ? { credentials: config.firestoreKeyJson } : {}),
          ...(config.firestoreEncryptionKey ? { encryptionKey: config.firestoreEncryptionKey } : {}),
        })
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
let erpbridgeSession: ErpbridgeMcpSession | null = null;
if (config.mcpTransport === "erpbridge-mcp") {
  try {
    erpbridgeSession = await createErpbridgeMcpSession({
      baseURL: config.erpbridgeBaseURL,
      token: config.erpbridgeMcpToken,
      timeoutMs: config.mcpTimeoutMs,
      validator,
    });
  } catch (err) {
    console.warn("[erpbridge] MCP session failed to start — ERP tools will be unavailable:", err instanceof Error ? err.message : String(err));
  }
}
const clientFor = (definition: ToolDefinition): GovernedMCPClient | null =>
  erpbridgeSession !== null
    ? erpbridgeSession.clientFor(definition)
    : legacyMcp;
const toolRegistry = new ToolRegistry();
for (const definition of registries.snapshot().tools) {
  const client = clientFor(definition);
  if (client !== null)
    toolRegistry.register(new GenericMCPTool(definition.name, definition.description, client));
}
registries.onToolUpsert((definition) => {
  if (!toolRegistry.has(definition.name)) {
    const client = clientFor(definition);
    if (client !== null)
      toolRegistry.register(new GenericMCPTool(definition.name, definition.description, client));
  }
});

// Bootstrap toolRegistry with live ERP Bridge tools discovered at startup.
// discoverTools() only feeds the synthesis prompt; without this step the executor
// cannot dispatch workflow steps that call ERP Bridge tools not in the static JSON registry.
if (erpbridgeSession !== null) {
  try {
    const liveErpTools = await erpbridgeSession.listTools();
    for (const liveT of liveErpTools) {
      if (!toolRegistry.has(liveT.name)) {
        const minimalDef = { mcp_tool_name: liveT.name, allowed_roles: [] } as unknown as ToolDefinition;
        const client = clientFor(minimalDef);
        if (client !== null)
          toolRegistry.register(new GenericMCPTool(liveT.name, liveT.description ?? "", client));
      }
    }
    console.log(`[erpbridge] Bootstrapped ${liveErpTools.length} live ERP tools into executor`);
  } catch (err) {
    console.warn("[erpbridge] Could not bootstrap live tools into executor:", err instanceof Error ? err.message : String(err));
  }
}

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
const policyGateClient =
  (config.policyGateURL ?? "") !== "" && (config.policyGateAPIKey ?? "") !== ""
    ? new PolicyGateClient({
        url: config.policyGateURL!,
        apiKey: config.policyGateAPIKey!,
        timeoutMs: config.policyGateTimeoutMs,
      })
    : null;
const validationGate = new GovernedValidationGate(
  governance,
  validator,
  registries,
  repository,
  policyGateClient,
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
const schedulerInterval = setInterval(() => { void runScheduledWorkflows(); }, 60_000);
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(schedulerInterval);
  await app.close();
  await erpbridgeSession?.close();
  await repository.close();
  // Explicit exit so lingering async handles (Firestore listeners, timers) don't keep the
  // process alive after the HTTP port is closed — prevents EADDRINUSE on --watch restarts.
  process.exit(0);
};
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
await app.listen({ host: "0.0.0.0", port: config.port });
console.log("[scheduler] Workflow cron scheduler started (60 s tick)");

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

// ── Cron scheduler ────────────────────────────────────────────────────────────
function cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  return field.split(",").some((part) => {
    const n = parseInt(part.trim(), 10);
    return !Number.isNaN(n) && n === value;
  });
}

function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  return (
    cronFieldMatches(min, date.getUTCMinutes()) &&
    cronFieldMatches(hour, date.getUTCHours()) &&
    cronFieldMatches(dom, date.getUTCDate()) &&
    cronFieldMatches(mon, date.getUTCMonth() + 1) &&
    cronFieldMatches(dow, date.getUTCDay())
  );
}

async function runScheduledWorkflows(): Promise<void> {
  const tick = new Date();
  const scheduled = await repository.read((state) =>
    Object.values(state.workflows).filter((wf) => {
      if (wf.archived) return false;
      const trig = wf.trigger as Record<string, unknown> | null | undefined;
      if (!trig || trig.type !== "schedule") return false;
      const cfg = trig.config as Record<string, unknown> | null | undefined;
      return typeof cfg?.cron === "string" && (cfg.cron as string).trim() !== "";
    })
  );
  if (scheduled.length === 0) return;

  for (const wf of scheduled) {
    const trig = wf.trigger as Record<string, unknown>;
    const cfg = trig.config as Record<string, unknown>;
    const cronExpr = cfg.cron as string;
    if (!cronMatches(cronExpr, tick)) continue;

    if (!wf.yaml) {
      console.warn(`[scheduler] ${wf.id} has no YAML — skipping`);
      continue;
    }

    const execId = `run-${randomBytes(4).toString("hex")}`;
    try {
      const gate = await validator.validateAndIssueToken("scheduled", wf.yaml, "admin");
      if (!gate.token) {
        console.warn(`[scheduler] ${wf.id} blocked by validator — skipping`);
        continue;
      }
      const startedAt = new Date().toISOString();
      await repository.mutate((state) => {
        state.executions[execId] = {
          id: execId,
          workflowId: wf.id,
          workflowName: wf.name,
          status: "RUNNING",
          startedAt,
          completedAt: null,
          durationMs: 0,
          tokens: { input: 0, output: 0, total: 0 },
          costUsd: 0,
          startedBy: { id: "system", name: "Scheduler" },
        };
      });
      const nowIso = new Date().toISOString();
      let finalState: Record<string, unknown>;
      let finalTimeline: Array<{ id: string; nodeId: string; label: string; status: string; startedAt: string; completedAt: string; durationMs: number; output: unknown }>;
      let finalLogs: Array<{ level: string; nodeId: string; timestamp: string; message: string; metadata: unknown }>;
      let finalTokens: { input: number; output: number; total: number };

      // LLM-driven execution via ERP Bridge when both are available.
      // Falls back to legacy executor when either is unavailable.
      if (erpbridgeSession !== null && providerRuntime !== null && providerRuntime.configured) {
        const liveTools = await discoverTools(erpbridgeSession, registries);
        const taskLines: string[] = [`Execute workflow: ${wf.name}`];
        if (wf.description) taskLines.push(`Description: ${wf.description}`);
        try {
          const bp = parseWorkflowYAMLStrict(wf.yaml!);
          if (bp.steps.length > 0) {
            taskLines.push("Steps to execute in order:");
            bp.steps.forEach((s, i) => {
              const paramStr = s.parameters && Object.keys(s.parameters).length > 0
                ? ` with parameters: ${JSON.stringify(s.parameters)}` : "";
              taskLines.push(`${i + 1}. ${s.description || s.action} — use tool "${s.action}"${paramStr}`);
            });
          }
        } catch { /* use name/description only */ }
        taskLines.push("Execute ALL steps in order using the exact tool names listed. If a tool name differs only in hyphens vs underscores, use the closest available tool.");
        const actionResult = await runActionLoop(
          { userMessage: taskLines.join("\n"), chatHistory: [], sessionId: execId, actorId: "system", actorRole: "admin", user: { id: "system", role: "admin", department: null } },
          liveTools,
          async (toolName, args) => erpbridgeSession.callToolDirect(toolName, args),
          async () => ({ allowed: true }),
          providerRuntime,
        );
        finalState = Object.fromEntries(actionResult.steps.map((s, i) => [`step_${i + 1}_${s.toolName}`, s.result]));
        finalTimeline = actionResult.steps.map((s, i) => ({ id: `tl_${i + 1}`, nodeId: `step_${i + 1}`, label: s.toolName, status: "DONE", startedAt: nowIso, completedAt: nowIso, durationMs: 0, output: s.result }));
        finalLogs = actionResult.steps.map((s, i) => ({ level: "info", nodeId: `step_${i + 1}`, timestamp: nowIso, message: `${s.toolName}: completed`, metadata: null }));
        finalTokens = { input: actionResult.totalTokens.input, output: actionResult.totalTokens.output, total: actionResult.totalTokens.input + actionResult.totalTokens.output };
      } else {
        const dispatchId = createDispatchIdentity({ id: "system", role: "admin" }, config.erpbridgeRoleMap);
        const result = await executor.run(execId, wf, {}, gate.token, dispatchId, undefined, { traceId: execId, workflowId: wf.id, executionId: execId, actor: { id: "system", role: "admin" } });
        finalState = result.state;
        finalTimeline = result.timeline.map((t) => ({ id: (t as { id?: string }).id ?? `tl_0`, nodeId: t.nodeId, label: t.nodeId, status: "DONE", startedAt: nowIso, completedAt: nowIso, durationMs: t.durationMs, output: t.output }));
        finalLogs = result.logs;
        finalTokens = result.tokens;
      }

      const completedAt = new Date().toISOString();
      await repository.mutate((state) => {
        const item = state.executions[execId];
        if (item === undefined) return;
        item.status = "DONE";
        item.completedAt = completedAt;
        item.durationMs = Date.now() - new Date(startedAt).getTime();
        item.tokens = finalTokens;
        item.stepOutputs = Object.fromEntries(
          Object.entries(finalState).filter(([k]) => k !== "input"),
        );
        item.finalOutput = finalTimeline.at(-1)?.output;
        state.executionLogs[execId] = finalLogs.map((log, i) => ({
          id: `log_${i + 1}`,
          executionId: execId,
          ...log,
          traceId: execId,
        }));
        state.timelines[execId] = finalTimeline.map((entry) => ({ ...entry, traceId: execId }));
        const storedWf = state.workflows[wf.id];
        if (storedWf !== undefined) {
          storedWf.lastRunAt = completedAt;
          storedWf.status = "DONE";
          storedWf.updatedAt = completedAt;
        }
      });
      console.log(`[scheduler] ${wf.name} → ${execId} DONE`);
    } catch (err) {
      console.warn(`[scheduler] ${wf.id} failed:`, err instanceof Error ? err.message : String(err));
      await repository.mutate((state) => {
        const item = state.executions[execId];
        if (item === undefined) return;
        item.status = "FAILED";
        item.completedAt = new Date().toISOString();
        item.durationMs = Date.now() - new Date(item.startedAt).getTime();
      }).catch(() => {});
    }
  }
}
