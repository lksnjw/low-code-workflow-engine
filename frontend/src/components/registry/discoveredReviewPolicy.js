import { supportedReviewPolicy } from "./capabilityReviewPolicy";

export function operationOutputFields(schema, path = [], depth = 0) {
  if (!schema || depth > 12) return [];
  if (["boolean", "string", "number", "integer"].includes(schema.type) && path.length) return [{ path, type: schema.type }];
  return schema.type === "object" ? Object.entries(schema.properties ?? {}).filter(([key]) => !["__proto__", "prototype", "constructor"].includes(key))
    .flatMap(([key, field]) => operationOutputFields(field, [...path, key], depth + 1)) : [];
}
export function supportedImportDecision(body) {
  if (!supportedReviewPolicy(body) || body.confirmed !== true || typeof body.remoteName !== "string" || !body.remoteName || body.remoteName.length > 256 ||
      !/^sha256:[a-f0-9]{64}$/.test(body.remoteHash ?? "") || !/^[A-Za-z0-9_-]{16,128}$/.test(body.decisionKey ?? "") ||
      !Array.isArray(body.allowedRoles) || !body.allowedRoles.length || body.allowedRoles.length > 32 || new Set(body.allowedRoles).size !== body.allowedRoles.length ||
      body.allowedRoles.some(role => typeof role !== "string" || !role.trim() || role.length > 128) || typeof body.note !== "string" || !body.note.trim() || body.note.length > 2000) return false;
  const keys = ["remoteName", "remoteHash", "decisionKey", "allowedRoles", "effectClass", "riskClass", "dataClass", "retryPolicy", "note", "confirmed"];
  if (body.effectClass !== "read") {
    keys.push("sideEffects", "operationContract", "requireIndependentApproval");
    const contract = body.operationContract, proof = contract?.confirmation;
    if (contract?.profile !== "operation-result/v1" || contract.effect_class !== body.effectClass || contract.retry_policy !== "never" || !proof ||
        !["operation-accepted", "operation-confirmed"].includes(proof.meaning) || !Array.isArray(proof.path) || !proof.path.length || proof.path.length > 12 ||
        proof.path.some(part => typeof part !== "string" || !part || ["__proto__", "prototype", "constructor"].includes(part)) ||
        !["string", "number", "boolean"].includes(typeof proof.expected) || typeof proof.expected === "number" && !Number.isFinite(proof.expected) ||
        typeof proof.expected === "string" && (!proof.expected || proof.expected.length > 256) ||
        !Array.isArray(body.sideEffects) || !body.sideEffects.length || body.sideEffects.length > 32 || body.sideEffects.some(value => typeof value !== "string" || !value.trim() || value.length > 256)) return false;
  }
  return Object.keys(body).every(key => keys.includes(key));
}
export function importReceiptMatches(decision, result) {
  const revision = result?.revision, definition = revision?.definition, admission = result?.admission;
  const version = definition?.bridge_contract?.resource_version;
  if (typeof version !== "string") return false;
  const selector = definition.bridge_contract.selector;
  if (selector !== undefined && !["digest-pinned-alias", "digest-pinned-operation-alias"].includes(selector)) return false;
  if (selector === "digest-pinned-alias" && (decision.body.effectClass !== "read" || definition.is_read_only !== true ||
      !/^[a-f0-9]{64}$/.test(definition.bridge_contract.resource_digest ?? ""))) return false;
  if (selector === "digest-pinned-operation-alias" && (decision.body.effectClass !== "write" || definition.is_read_only !== false ||
      !["erpnext-item-create/v1", "erpnext-item-update/v1", "erpnext-stock-receipt-draft/v1"].includes(definition.operation_contract?.receipt_profile) ||
      decision.body.riskClass !== "medium" || !/^[a-f0-9]{64}$/.test(definition.bridge_contract.resource_digest ?? ""))) return false;
  const remoteName = selector ? definition.mcp_tool_name :
    `${definition.mcp_tool_name}.rev_${btoa(version).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
  return result.remoteHash === decision.body.remoteHash && remoteName === decision.body.remoteName && revision.connectionId === decision.connectionId &&
    definition.connection_id === decision.connectionId && revision.capabilityId === admission?.capabilityId &&
    ["AVAILABLE", "DISABLED", "BLOCKED"].includes(admission?.state) && definition.risk_level === decision.body.riskClass &&
    definition.is_read_only === (decision.body.effectClass === "read") && JSON.stringify(definition.allowed_roles) === JSON.stringify(decision.body.allowedRoles) &&
    (decision.body.effectClass === "read" ? definition.side_effects?.length === 0 :
      JSON.stringify(definition.operation_contract) === JSON.stringify(decision.body.operationContract) && JSON.stringify(definition.side_effects) === JSON.stringify(decision.body.sideEffects));
}
