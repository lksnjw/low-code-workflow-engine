import { canonicalJSONBytes } from "../core/canonical-json.js";
import type { ToolDefinition } from "../registry/schemas.js";
import type { ErpbridgeMcpSdkTool } from "./erpbridge-mcp-client.js";
import { validateToolSchemaProfile } from "./tool-input-schema.js";
import { isErpnextWriteContract } from "./erpnext-document-write.js";

export function exactBridgeName(tool: ToolDefinition): string {
  const name = tool.mcp_tool_name.trim();
  return tool.bridge_contract && !tool.bridge_contract.selector
    ? `${name}.rev_${Buffer.from(tool.bridge_contract.resource_version).toString("base64url")}` : name;
}
export function hasReservedBridgeRole(tool: ToolDefinition): boolean {
  return tool.bridge_contract ? tool.bridge_contract.remote_roles.length > 0 : tool.allowed_roles.length > 0;
}
export function bridgeTransportSchema(tool: ToolDefinition): Record<string, unknown> {
  const schema = structuredClone(tool.input_schema), contract = tool.bridge_contract;
  if (contract?.trusted_input && "actor" in contract.trusted_input) {
    if (!["rag-policy-assist", "rag-policy-evaluate"].includes(tool.mcp_tool_name)) throw new Error("Unsupported trusted actor transport");
    const properties = schema.properties as Record<string, unknown>;
    if (Object.hasOwn(properties, "actor")) throw new Error("Workflow cannot author the policy actor");
    schema.properties = { ...properties, actor: contract.trusted_input.actor };
    schema.required = [...contract.trusted_input.required];
  }
  if (contract?.trusted_input && "access_token" in contract.trusted_input) {
    if (!["pipeline-library-discover", "pipeline-library-resolve", "pipeline-library-search"].includes(tool.mcp_tool_name)) throw new Error("Unsupported document delegation transport");
    const properties = schema.properties as Record<string, unknown>;
    if (Object.hasOwn(properties, "access_token")) throw new Error("Workflow cannot author document delegation");
    schema.properties = { ...properties, access_token: contract.trusted_input.access_token };
  }
  if (contract?.remote_roles.length) {
    const properties = typeof schema.properties === "object" && schema.properties !== null && !Array.isArray(schema.properties) ? schema.properties : {};
    if (Object.hasOwn(properties, "role")) throw new Error("Guarded business schema cannot reserve the transport role selector");
    schema.properties = { ...properties, role: { type: "string", description: "Authorization role used for this tool call", enum: [...contract.remote_roles].sort() } };
  }
  return schema;
}
const same = (a: unknown, b: unknown) => canonicalJSONBytes(a).equals(canonicalJSONBytes(b));
export function matchesBridgeContract(tool: ToolDefinition, remote: ErpbridgeMcpSdkTool): boolean {
  if (remote.name !== exactBridgeName(tool)) return false;
  const contract = tool.bridge_contract;
  if (!contract) return same(tool.input_schema, remote.inputSchema);
  if (!tool.mcp_tool_name.trim() || tool.mcp_tool_name.includes(".rev_") || validateToolSchemaProfile(tool.input_schema).length ||
      (contract.output_schema && validateToolSchemaProfile(contract.output_schema).length)) return false;
  const meta = remote._meta;
  if (contract.selector === "digest-pinned-alias" && (meta?.["toolplane.serving"] !== true ||
      remote.annotations?.readOnlyHint !== true || remote.annotations?.destructiveHint === true)) return false;
  if (contract.selector === "digest-pinned-operation-alias" && (meta?.["toolplane.serving"] !== true ||
      remote.annotations?.readOnlyHint !== false || tool.is_read_only || !isErpnextWriteContract(tool) || !remote.outputSchema)) return false;
  if (contract.selector === "digest-pinned-mcp-operation-alias" && (meta?.["toolplane.serving"] !== true ||
      remote.annotations?.readOnlyHint === true || tool.is_read_only || tool.operation_contract?.confirmation.source !== "mcp-envelope")) return false;
  const roles = meta?.["io.erpbridge/allowedRoles"] ?? [];
  if (!Array.isArray(roles) || roles.some(role => typeof role !== "string") || new Set(roles).size !== roles.length ||
      !same([...roles].sort(), [...contract.remote_roles].sort()) ||
      meta?.["toolplane.resourceDigest"] !== contract.resource_digest || meta?.["toolplane.resourceVersion"] !== contract.resource_version ||
      !same(remote.outputSchema ?? null, contract.output_schema ?? null)) return false;
  try { return same(bridgeTransportSchema(tool), remote.inputSchema); } catch { return false; }
}
