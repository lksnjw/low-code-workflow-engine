import { createHash } from "node:crypto";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { toolSchema, type ToolDefinition } from "./schemas.js";
import { matchesBridgeContract } from "../tools/erpbridge-contract.js";
import type { ErpbridgeMcpSdkTool } from "../tools/erpbridge-mcp-client.js";
import { validateToolSchemaProfile } from "../tools/tool-input-schema.js";
import { erpnextWriteContract } from "../tools/erpnext-document-write.js";

export const remoteContractHash = (remote: ErpbridgeMcpSdkTool) => `sha256:${createHash("sha256").update(canonicalJSONBytes(remote)).digest("hex")}`;
export const remoteCatalogHash = (tools: readonly ErpbridgeMcpSdkTool[]) => `sha256:${createHash("sha256").update(canonicalJSONBytes([...tools].sort((a, b) => a.name.localeCompare(b.name)))).digest("hex")}`;

/** Identifiers are server-owned and connection-scoped, never supplied by a
 * model, a tool description or the import request. Version remains in the pin. */
export function discoveredToolIdentity(connectionId: string, baseName: string) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(connectionId) || !baseName.trim() || baseName.length > 256 || baseName.includes(".rev_"))
    throw new Error("Unsupported discovered tool identity");
  const digest = createHash("sha256").update(canonicalJSONBytes([connectionId, baseName])).digest("hex");
  const label = baseName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 55);
  return { tool_id: `DISCOVERED-${digest}`, name: `discovered.${connectionId.slice(0, 20)}.${label}_${digest.slice(0, 16)}` };
}

/** Shape only. Deliberately no local role grant, read attestation, business
 * classification or admission. MCP annotations are advisory evidence. */
export function discoveredContract(remote: ErpbridgeMcpSdkTool, connectionId: string): ToolDefinition {
  if (canonicalJSONBytes(remote).length > 65536) throw new Error("Discovered tool exceeds the supported contract budget");
  const meta = remote._meta ?? {}, version = meta["toolplane.resourceVersion"], digest = meta["toolplane.resourceDigest"];
  if (typeof version !== "string") throw new Error("A versioned ERPBridge contract is required");
  const suffix = `.rev_${Buffer.from(version).toString("base64url")}`;
  const qualified = remote.name.endsWith(suffix);
  // A serving alias is not permission. It may only become an explicitly
  // reviewed read; every dispatch still pins the actual server-owned digest.
  const alias = !qualified && !remote.name.includes(".rev_") && meta["toolplane.serving"] === true &&
    remote.annotations?.readOnlyHint === true && remote.annotations?.destructiveHint !== true;
  const operationContract = !qualified && !remote.name.includes(".rev_") && meta["toolplane.serving"] === true &&
    !alias && remote.annotations?.readOnlyHint !== true ? erpnextWriteContract(remote.name) ?? {
      profile: "operation-result/v1" as const, effect_class: "write" as const, retry_policy: "never" as const,
      confirmation: { source: "mcp-envelope" as const, path: ["acknowledged"], expected: true, meaning: "operation-accepted" as const },
    } : undefined;
  if (!qualified && !alias && !operationContract) throw new Error("An exact versioned ERPBridge tool name or supported digest-pinned alias is required");
  const baseName = qualified ? remote.name.slice(0, -suffix.length) : remote.name, roles = meta["io.erpbridge/allowedRoles"] ?? [];
  const input = structuredClone(remote.inputSchema);
  const policyActor = ["rag-policy-actions", "rag-policy-assist", "rag-policy-evaluate"].includes(baseName) &&
    input.properties && typeof input.properties === "object" && !Array.isArray(input.properties) ? (input.properties as Record<string, unknown>).actor : undefined;
  if (policyActor) {
    delete (input.properties as Record<string, unknown>).actor;
    if (Array.isArray(input.required)) input.required = input.required.filter(key => key !== "actor");
  }
  const libraryToken = ["pipeline-library-discover", "pipeline-library-resolve", "pipeline-library-search"].includes(baseName) &&
    input.properties && typeof input.properties === "object" && !Array.isArray(input.properties) ? (input.properties as Record<string, unknown>).access_token : undefined;
  if (libraryToken) delete (input.properties as Record<string, unknown>).access_token;
  if (Array.isArray(roles) && roles.length && input.properties && typeof input.properties === "object" && !Array.isArray(input.properties))
    delete (input.properties as Record<string, unknown>).role;
  const tool = toolSchema.parse({ ...discoveredToolIdentity(connectionId, baseName), connection_id: connectionId, mcp_tool_name: baseName,
    display_name: baseName, description: (remote.description ?? "").slice(0, 2000), input_schema: input, is_read_only: false,
    risk_level: "unreviewed", allowed_roles: [], required_parameters: Array.isArray(input.required) ? input.required : [],
    ...(operationContract ? { operation_contract: operationContract } : {}),
    bridge_contract: { profile: "toolplane-v1", resource_version: version, resource_digest: digest, remote_roles: roles,
      ...(policyActor ? { trusted_input: { actor: policyActor, required: remote.inputSchema.required ?? [] } } : {}),
      ...(libraryToken ? { trusted_input: { access_token: libraryToken } } : {}),
      ...(alias ? { selector: "digest-pinned-alias" } : {}),
      ...(operationContract ? { selector: operationContract.confirmation.source === "mcp-envelope" ? "digest-pinned-mcp-operation-alias" : "digest-pinned-operation-alias" } : {}),
      ...(remote.outputSchema ? { output_schema: remote.outputSchema } : {}) } });
  if (tool.input_schema.type !== "object" || validateToolSchemaProfile(tool.input_schema).length ||
      (tool.bridge_contract?.output_schema && validateToolSchemaProfile(tool.bridge_contract.output_schema).length) || !matchesBridgeContract(tool, remote))
    throw new Error("The discovered input/output/role contract is not supported exactly");
  return tool;
}

export function discoveredCapabilityPreview(remote: ErpbridgeMcpSdkTool, connectionId: string) {
  const identity = { remoteName: remote.name, remoteHash: remoteContractHash(remote), state: "DISCOVERED", reason: "NO_LOCAL_REVIEW_CONTRACT", authorityGranted: false };
  try {
    return { ...identity, importable: true, definition: discoveredContract(remote, connectionId), hints: {
      readOnly: remote.annotations?.readOnlyHint === true, destructive: remote.annotations?.destructiveHint === true,
      advisoryOnly: true } };
  } catch { return { ...identity, importable: false, unsupportedReason: "A supported exact version/digest contract and schema review are required" }; }
}
