import type { AppConfig } from "../config/config.js";
import type { ValidationGate } from "../governance/gate.js";
import type { ProviderRuntime } from "../providers/runtime.js";
import type { RegistryService } from "../registry/service.js";
import type { Repository } from "../repository/store.js";
import type { Executor } from "../runner/executor.js";
import type { SynthesisService } from "../synthesis/service.js";
import type { ErpbridgeMcpSession } from "../tools/erpbridge-mcp-client.js";
import type { McpConnectionManager, McpConnectionRuntime } from "../tools/mcp-connection-runtime.js";
import type { RegistryValidator } from "../validator/registry-validator.js";

/** Runtime dependencies owned by the HTTP composition root. Route modules
 * consume this contract; they do not construct or replace shared services. */
export type ApplicationServices = {
  config: AppConfig;
  repository: Repository;
  registries: RegistryService;
  validator: RegistryValidator;
  validationGate?: ValidationGate;
  executor: Executor;
  providerRuntime?: ProviderRuntime;
  synthesis?: SynthesisService;
  erpbridgeSession?: ErpbridgeMcpSession | undefined;
  mcpConnectionRuntime?: McpConnectionRuntime | McpConnectionManager;
  contextAvailable?: boolean;
  userMcpCredentials?: import("../tools/user-mcp-credentials.js").UserMcpCredentials;
};
