import { dirname, resolve } from "node:path";
import { constants } from "node:fs";
import { access, copyFile, mkdir } from "node:fs/promises";
import type { AppConfig } from "../config/config.js";
import type { ApplicationServices } from "../http/application-services.js";
import { RegistryService, ensureRuntimeRegistries } from "../registry/service.js";
import { requireProductionAdmissionProfile } from "../registry/capability-admission.js";
import type { Repository } from "../repository/store.js";
import { openApplicationRepository } from "../storage/open-repository.js";
import { RegistryValidator } from "../validator/registry-validator.js";
import { McpConnectionManager } from "../tools/mcp-connection-runtime.js";
import { createGovernedMCPClient } from "../tools/mcp-client.js";
import { createExecutorToolBoundary } from "../tools/executor-tool-boundary.js";
import { Executor } from "../runner/executor.js";
import { ProviderRuntime } from "../providers/runtime.js";
import { staticProviderConfiguration } from "../providers/static-configuration.js";
import { GovernanceAdapter } from "../governance/adapter.js";
import { GovernanceService } from "../governance/service.js";
import { GovernedValidationGate } from "../governance/gate.js";
import { LlmPolicyFallback } from "../governance/llm-fallback.js";
import { checkRecordWorkflowPolicy } from "../governance/record-workflow-policy.js";
import { PolicyGateClient } from "../governance/policy-gate-client.js";
import { SynthesisService } from "../synthesis/service.js";
import { restoreImportedCapabilities } from "../registry/capability-import.js";
import { UserMcpCredentials } from "../tools/user-mcp-credentials.js";

export const APPLICATION_STORAGE_TIMEOUT_MS = 30_000;

export type ApplicationResources = Readonly<{
  config: AppConfig;
  registries: RegistryService;
  repository: Repository;
  close(): Promise<void>;
}>;

export type ApplicationRuntime = Readonly<{
  services: ApplicationServices;
  close(): Promise<void>;
}>;

/** One ownership scope spans repository opening and later service construction.
 * Closing waits for in-progress construction, then disposes in reverse order.
 * A failed disposer never prevents the remaining owners from being cleaned. */
class RuntimeOwner {
  private readonly disposers: (() => void | Promise<void>)[] = [];
  private closeResult: Promise<void> | undefined;
  private construction: Promise<void> | undefined;
  private finish: (() => void) | undefined;
  private constructed = false;
  private closing = false;

  add(dispose: () => void | Promise<void>) { this.disposers.push(dispose); }
  assertOpen() { if (this.closing) throw new Error("Application resources are closing or closed"); }
  begin() {
    this.assertOpen();
    if (this.constructed) throw new Error("Application runtime has already been constructed for these resources");
    this.constructed = true;
    this.construction = new Promise(resolveConstruction => { this.finish = resolveConstruction; });
  }
  finishConstruction() { this.finish?.(); }
  close(): Promise<void> {
    if (this.closeResult) return this.closeResult;
    this.closing = true;
    this.closeResult = (async () => {
      await this.construction;
      const failures: unknown[] = [];
      for (const dispose of this.disposers.reverse()) {
        try { await dispose(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "Application resource cleanup could not be fully confirmed");
    })();
    return this.closeResult;
  }
}

const owners = new WeakMap<ApplicationResources, RuntimeOwner>();

/** Opens current registry/storage resources only. The process host remains
 * responsible for credential bootstrap and interrupted-execution reconciliation. */
export async function openApplicationResources(input: {
  config: AppConfig;
  root: string;
  registryPreparation?: "resident-bootstrap" | "existing-only";
  onRegistriesLoaded?: () => void;
  reuseVerifiedFirestoreImages?: boolean;
}): Promise<ApplicationResources> {
  const { config, root } = input;
  if (input.registryPreparation !== undefined && !["resident-bootstrap", "existing-only"].includes(input.registryPreparation))
    throw new Error("Unsupported registry preparation policy");
  if (input.registryPreparation === "existing-only") {
    // Functions assets are immutable. Missing assets are an artifact failure,
    // never permission to copy fixtures into an invocation or bootstrap state.
    await access(resolve(dirname(config.toolRegistryPath), "registry_context.md"), constants.R_OK);
  } else {
    await ensureRuntimeRegistries({ toolPath: config.toolRegistryPath, rulePath: config.ruleRegistryPath,
    frozenToolPath: resolve(root, "fixtures/parity/http/runtime/all_tools_master_registry.json"),
    frozenRulePath: resolve(root, "fixtures/parity/http/runtime/all_rules_master_registry.json") });
  await ensureRuntimeContext(resolve(root, "fixtures/parity/http/runtime/registry_context.md"),
    resolve(dirname(config.toolRegistryPath), "registry_context.md"));
  }
  const registries = await RegistryService.load(config.toolRegistryPath, config.ruleRegistryPath);
  input.onRegistriesLoaded?.();
  // This opener already owns its deadline and disposal of late storage resources.
  const repository = await openApplicationRepository(config, APPLICATION_STORAGE_TIMEOUT_MS, { reuseVerifiedFirestoreImages: input.reuseVerifiedFirestoreImages === true });
  const owner = new RuntimeOwner();
  owner.add(() => repository.close());
  const resources = Object.freeze({ config, registries, repository, close: () => owner.close() });
  owners.set(resources, owner);
  return resources;
}

/** Constructs governed services without HTTP, listeners, signals or workers.
 * This extraction alone is not a bounded execution host or a Functions adapter. */
export async function constructApplicationRuntime(resources: ApplicationResources, options: {deferMcpConnection?:boolean} = {}): Promise<ApplicationRuntime> {
  const owner = owners.get(resources);
  if (!owner) throw new Error("Application resources must be opened by the owned resource factory");
  owner.begin();
  const { config, repository, registries } = resources;
  try {
    await restoreImportedCapabilities(repository, registries);
    owner.assertOpen();
    const validator = new RegistryValidator(registries, repository);
    requireProductionAdmissionProfile(config);
    const legacyMcp = config.mcpTransport === "bridge-v1" ? createGovernedMCPClient({
      baseURL: config.mcpBaseURL, timeoutMs: config.mcpTimeoutMs, mode: config.mcpMode, validator,
    }) : null;
    const userMcpCredentials = config.mcpTransport === "erpbridge-mcp" && config.mcpMode === "remote"
      ? new UserMcpCredentials(repository, config) : undefined;
    if (userMcpCredentials) owner.add(() => userMcpCredentials.close());
    const mcpConnectionRuntime = await McpConnectionManager.open({ config, repository, registries, validator, ...(userMcpCredentials ? { userMcpCredentials } : {}), ...(options.deferMcpConnection ? {deferConnection:true} : {}) });
    owner.add(() => mcpConnectionRuntime.stop());
    owner.assertOpen();
    const executorTools = createExecutorToolBoundary({ transport: config.mcpTransport, tools: registries, legacyClient: legacyMcp });
    owner.add(() => executorTools.close());
    const executor = new Executor(executorTools.registry, validator);
    const providerRuntime = new ProviderRuntime(repository, executor);
    await providerRuntime.activateStoredOrStatic(staticProviderConfiguration(config), config.generationTimeoutMs ?? 30_000);
    owner.assertOpen();
    const governancePrimary = (config.governanceURL ?? "") === "" ? null : new GovernanceAdapter({
      url: config.governanceURL!, apiKey: config.governanceAPIKey ?? "", timeoutMs: config.governanceTimeoutMs ?? 10_000, source: "primary",
    });
    const governanceSecondary = (config.governanceSecondaryURL ?? "") === "" ? null : new GovernanceAdapter({
      url: config.governanceSecondaryURL!, apiKey: config.governanceAPIKey ?? "", timeoutMs: config.governanceTimeoutMs ?? 10_000, source: "secondary",
    });
    const governanceLlmFallback = new LlmPolicyFallback({ openrouterApiKey: config.governanceFallbackLlmApiKey,
      model: config.governanceFallbackLlmModel, policyPath: config.governanceFallbackPolicyPath, timeoutMs: config.governanceFallbackLlmTimeoutMs });
    const governance = new GovernanceService(governancePrimary, governanceSecondary, config.governanceCacheTTLms ?? 0,
      registries, repository, governanceLlmFallback);
    await governance.initialize();
    owner.assertOpen();
    const policyGateClient = (config.policyGateURL ?? "") !== "" && (config.policyGateAPIKey ?? "") !== "" ? new PolicyGateClient({
      url: config.policyGateURL!, apiKey: config.policyGateAPIKey!, timeoutMs: config.policyGateTimeoutMs,
    }) : null;
    const validationGate = new GovernedValidationGate(governance, validator, registries, repository, policyGateClient,
      (yaml, user, context) => checkRecordWorkflowPolicy(services, yaml, user, context));
    const synthesis = new SynthesisService(providerRuntime, registries, validator, validationGate);
    const services: ApplicationServices = { config, repository, registries, validator, validationGate, executor, providerRuntime,
      synthesis, contextAvailable: true, mcpConnectionRuntime, ...(userMcpCredentials ? { userMcpCredentials } : {}), get erpbridgeSession() { return mcpConnectionRuntime.session; } };
    owner.finishConstruction();
    return Object.freeze({ services, close: () => owner.close() });
  } catch (error) {
    owner.finishConstruction();
    try { await owner.close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Application construction failed and cleanup could not be fully confirmed"); }
    throw error;
  }
}

async function ensureRuntimeContext(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  try { await copyFile(source, target, constants.COPYFILE_EXCL); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

