import { createClient } from "@erpbridge/sdk";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import type { ToolDefinition } from "../registry/schemas.js";
import type {
  DispatchCapability,
  RegistryValidator,
} from "../validator/registry-validator.js";
import type { DispatchIdentity } from "./registry.js";
import type { GovernedMCPClient } from "./mcp-client.js";

export type ErpbridgeMcpSdkTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type ErpbridgeMcpSdkClient = Readonly<{
  connect(): Promise<void>;
  close(): Promise<void>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  listTools(): Promise<readonly ErpbridgeMcpSdkTool[]>;
}>;

export type ErpbridgeMcpSession = Readonly<{
  clientFor(definition: ToolDefinition): GovernedMCPClient;
  callToolDirect(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  listTools(): Promise<readonly ErpbridgeMcpSdkTool[]>;
  close(): Promise<void>;
}>;

export class ErpbridgeMcpToolError extends Error {
  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a ErpbridgeMcpToolError instance with its required state.
   ******************************************************************************/
  constructor(readonly result: Record<string, unknown>) {
    super("MCP tool failed");
    this.name = "ErpbridgeMcpToolError";
  }
}

/*******************************************************************************
 * Function: createErpbridgeMcpSession
 *
 * Connects an ERPBridge MCP session and exposes its tool client adapters.
 ******************************************************************************/
export async function createErpbridgeMcpSession(options: {
  baseURL: string;
  token: string;
  timeoutMs: number;
  validator: RegistryValidator;
  sdkClient?: ErpbridgeMcpSdkClient;
}): Promise<ErpbridgeMcpSession> {
  const sdkClient =
    options.sdkClient ??
    createClient({
      baseUrl: options.baseURL,
      token: options.token,
      timeoutMs: options.timeoutMs,
      declaredScopes: ["mcp"],
      mcpRetryPolicy: "never",
    }).mcp;
  try {
    await sdkClient.connect();
  } catch (error) {
    await sdkClient.close().catch(() => {});
    throw error;
  }
  let closed = false;
  /*******************************************************************************
   * Function: close
   *
   * Closes the ERPBridge MCP session once.
   ******************************************************************************/
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await sdkClient.close();
  };
  return Object.freeze({
    /*******************************************************************************
     * Function: clientFor
     *
     * Creates a governed client for the selected ERPBridge tool definition.
     ******************************************************************************/
    clientFor: (definition: ToolDefinition) =>
      createToolClient(sdkClient, options.validator, definition, () => closed),
    /*******************************************************************************
     * Function: callToolDirect
     *
     * Calls a named tool directly through the connected ERPBridge SDK session.
     ******************************************************************************/
    callToolDirect: async (toolName: string, args: Record<string, unknown>) => {
      if (closed) throw new Error("ERPBridge MCP session is closed");
      const result = await sdkClient.callTool(toolName, args);
      const envelope = asResultRecord(result);
      if (envelope.isError === true) throw new ErpbridgeMcpToolError(envelope);
      return envelope;
    },
    /*******************************************************************************
     * Function: listTools
     *
     * Retrieves tool definitions from the connected ERPBridge MCP session.
     ******************************************************************************/
    listTools: () => sdkClient.listTools(),
    close,
  });
}

/*******************************************************************************
 * Function: createToolClient
 *
 * Builds an ERPBridge client that checks dispatch capability and role
 * access.
 ******************************************************************************/
function createToolClient(
  sdkClient: ErpbridgeMcpSdkClient,
  validator: RegistryValidator,
  definition: ToolDefinition,
  isClosed: () => boolean,
): GovernedMCPClient {
  const remoteName = definition.mcp_tool_name.trim();
  const guarded = definition.allowed_roles.length > 0;
  return Object.freeze({
    /*******************************************************************************
     * Function: execute
     *
     * Verifies dispatch authority and calls the mapped ERPBridge tool.
     ******************************************************************************/
    async execute(
      action: string,
      capability: DispatchCapability,
      parameters: Record<string, unknown>,
      identity: DispatchIdentity,
      signal?: AbortSignal,
    ): Promise<Record<string, unknown>> {
      if (signal?.aborted)
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted", "AbortError");
      const parameterBytes = canonicalJSONBytes(parameters);
      validator.verifyAndConsumeCapability(
        capability,
        action,
        parameterBytes,
        identity,
      );
      if (isClosed()) throw new Error("ERPBridge MCP session is closed");
      if (guarded && Object.hasOwn(parameters, "role"))
        throw new Error(
          "workflow-provided role is not allowed for a guarded ERPBridge tool",
        );
      if (guarded && identity.erpbridgeRole === null)
        throw new Error(
          "guarded ERPBridge tool requires a mapped ERPBridge role",
        );
      if (
        guarded &&
        !localRoleAllowed(identity.localRole, definition.allowed_roles)
      )
        throw new Error(
          "dispatch identity local role is not allowed for this ERPBridge tool",
        );
      const args = guarded
        ? { ...parameters, role: identity.erpbridgeRole! }
        : { ...parameters };
      const result = await sdkClient.callTool(remoteName || action, args);
      const envelope = asResultRecord(result);
      if (envelope.isError === true) throw new ErpbridgeMcpToolError(envelope);
      return envelope;
    },
  });
}

/*******************************************************************************
 * Function: asResultRecord
 *
 * Requires an ERPBridge tool result to be an object record.
 ******************************************************************************/
function asResultRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("ERPBridge MCP result must be an object");
  return value as Record<string, unknown>;
}

/*******************************************************************************
 * Function: localRoleAllowed
 *
 * Checks whether a normalized local role is in the allowed role list.
 ******************************************************************************/
function localRoleAllowed(role: string, allowed: readonly string[]): boolean {
  const normalized = normalizeRole(role);
  return allowed.some((item) => normalizeRole(item) === normalized);
}

/*******************************************************************************
 * Function: normalizeRole
 *
 * Normalizes a role name for comparison in this module.
 ******************************************************************************/
function normalizeRole(role: string): string {
  return role.trim().toLowerCase().replace(/[ -]/g, "_");
}
