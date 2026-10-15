import type { HandlerServices, CurrentUser } from "../http/handlers/common.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { isErpnextWriteContract } from "../tools/erpnext-document-write.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { effectiveUserFromState, type RepositoryState } from "../repository/store.js";
import { checkDirectRagPolicy, directRagConfigured } from "./direct-rag.js";
import { appendOptionalPolicyAudit, evaluateOptionalPolicy, policySwitches, assertLocalPolicyCurrentSync } from "./optional-policy.js";
import type { GovernedValidationContext, GovernanceUser } from "./gate.js";
import type { PolicyGateOutcome } from "./policy-gate-client.js";
import { usesCheckpointedOperationWorkflow } from "../workflows/execution-shape.js";

export class OperationPolicyBlocked extends Error {
  constructor(readonly decision: "deny" | "review" | "unavailable", readonly reason: string) {
    super(`ERP change stopped by policy (${decision}). ${reason}`);
  }
}

/** Fresh record-policy authority for literal, exactly reviewed record writes.
 * It supplements deterministic validation, never the tool/token or approval.
 * Other effects and unresolved runtime bindings retain the legacy gate. */
export async function checkRecordWorkflowPolicy(services: HandlerServices, yaml: string, actor: GovernanceUser,
  context: GovernedValidationContext): Promise<Exclude<PolicyGateOutcome, { outcome: "fallback" }> | null> {
  if (!directRagConfigured(services.config) || !await services.repository.read(state => policySwitches(state.settings.rbac).remote)) return null;
  let workflow;
  try { workflow = parseWorkflowYAMLStrict(yaml); } catch { return null; }
  const writes = workflow.steps.filter(step => services.registries.findTool(step.action ?? "")?.is_read_only !== true);
  if (!writes.length || writes.some(step => {
    const tool = services.registries.findTool(step.action ?? "");
    return !tool || !isErpnextWriteContract(tool) || !["create_customer", "create_item"].includes(tool.mcp_tool_name);
  })) return null;
  const user = await services.repository.effectiveUser(actor.id);
  if (!user || user.role !== actor.role || user.status.toLowerCase() !== "active") return { outcome: "deny", reason: "Record policy actor is no longer current." };
  for (const step of writes) {
    const tool = services.registries.findTool(step.action!)!;
    const reusable = /\{\{/.test(JSON.stringify(step.parameters));
    if (reusable && !usesCheckpointedOperationWorkflow(workflow, services.registries.snapshot().tools)) return null;
    const decision = await checkDirectRagPolicy(services.config, user, { prompt: "Validate the exact proposed record fields. This is not execution approval.",
      action: reusable ? "record_workflow_prepare" : tool.mcp_tool_name,
      context: reusable ? { recordAction: tool.mcp_tool_name, parameters: step.parameters, inputSchema: workflow.trigger?.config?.inputSchema }
        : { arguments: step.parameters, readOnly: false, domain: tool.module }, signal: context.signal });
    await services.repository.mutate(state => appendOptionalPolicyAudit(state, user, decision, context));
    const current = await services.repository.read(state => effectiveUserFromState(state, user.id));
    if (!current || current.status.toLowerCase() !== "active" || current.role !== user.role ||
      !canonicalJSONBytes([...current.permissions].sort()).equals(canonicalJSONBytes([...user.permissions].sort())) ||
      !await services.repository.read(state => policySwitches(state.settings.rbac).remote) || context.signal?.aborted)
      return { outcome: "deny", reason: "Record policy actor or settings changed during checking." };
    if (decision.decision !== "allow") return { outcome: decision.decision === "review" ? "review" : "deny", reason: decision.reason };
  }
  return { outcome: "allow", conditions: [], reason: "Current record-policy checks passed for this draft. Reusable bindings are preparation only; resolved fields require fresh per-operation policy checks, runtime approval and dispatch validation." };
}

/** Evaluated again on each worker turn, including the turn after approval.
 * The returned guard pins policy switches/actor/local JSON until intent commit. */
export async function prepareOperationPolicy(services: HandlerServices, user: CurrentUser, action: string,
  args: Record<string, unknown>, signal: AbortSignal, traceId?: string): Promise<(state: Readonly<RepositoryState>) => void> {
  const settings = await services.repository.read(state => policySwitches(state.settings.rbac));
  const decision = await evaluateOptionalPolicy(services, user, { prompt: "Validate this exact ERP change before approval and dispatch.", action,
    context: { arguments: args, readOnly: false }, signal, traceId });
  if (signal.aborted) throw new Error("ERP change policy check cancelled.");
  if (decision.decision !== "allow") throw new OperationPolicyBlocked(decision.decision, decision.reason);
  const expected = canonicalJSONBytes({ role: user.role, permissions: [...user.permissions].sort(), settings });
  return state => {
    services.repository.assertAuthority?.();
    // Execution checkpoints expose read-only proxy views. Read the minimal
    // authority fields directly; cloning the whole user would reject proxies.
    const current = state.users[user.id], role = current && state.roles[current.roleId];
    const permissions = [...new Set([...(role?.permissions ?? []), ...(current?.permissionOverrides ?? [])].filter(Boolean))].sort();
    if (signal.aborted || !current || current.status.toLowerCase() !== "active" || !expected.equals(canonicalJSONBytes({ role: role?.name ?? "",
      permissions, settings: policySwitches(state.settings.rbac) }))) throw new Error("ERP change policy authority changed before dispatch.");
    if (decision.source === "local_model" && decision.policyHash) assertLocalPolicyCurrentSync(services.config.governanceFallbackPolicyPath, decision.policyHash);
  };
}
