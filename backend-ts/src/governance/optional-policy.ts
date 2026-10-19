import { toolRoleAllowed } from "./tool-access.js";
import { readFile } from "node:fs/promises";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { boundedOperation, OperationDeadlineExceeded } from "../core/bounded-operation.js";
import type { HandlerServices, CurrentUser } from "../http/handlers/common.js";
import { effectiveUserFromState, type RepositoryState } from "../repository/store.js";
import { promptData } from "../prompts/contracts.js";
import { hasReservedBridgeRole } from "../tools/erpbridge-contract.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { fallbackPolicySchema } from "./llm-fallback.js";
import { interpretPolicyResponse } from "./rbac.js";
import { OpenAICompatibleError } from "../providers/openai-compatible.js";
import type { AnalysisResponse, GenerationDiagnostics, ProviderInvocationContext } from "../analysisprovider/types.js";
import { checkDirectRagPolicy, directRagConfigured } from "./direct-rag.js";
import { INTERACTIVE_HANDOFF_MS } from "../core/interactive-handoff.js";

export type PolicyDecision = {
  decision: "allow" | "deny" | "review" | "unavailable";
  source: "erpbridge" | "rag" | "local_model" | "skipped";
  reason: string;
  fallbackUsed?: boolean;
  policyVersion?: string;
  policyHash?: string;
  model?: string;
  promptTemplateVersion?: "prompt/local-policy/v2";
  generationDiagnostics?: GenerationDiagnostics;
  failureCode?: "LOCAL_POLICY_CONFIG_INVALID" | "LOCAL_POLICY_PROVIDER_FAILED" | "LOCAL_POLICY_RESPONSE_INVALID" | "POLICY_CHECK_CANCELLED";
};
export type PolicySwitches = { remote: boolean; local: boolean };
export const REMOTE_POLICY_HANDOFF_MS = INTERACTIVE_HANDOFF_MS;
export type PolicyRequest = { prompt: string; action: string; context?: Record<string, unknown>; signal?: AbortSignal | undefined; traceId?: string | undefined; sessionId?: string | undefined };
export type LocalPolicyPlan = { prompt: string; metadata: Required<Pick<PolicyDecision, "policyVersion" | "policyHash" | "promptTemplateVersion">>;
  context: ProviderInvocationContext };
export type PreparedOptionalPolicy = { settings: PolicySwitches; fallbackUsed: boolean } &
  ({ kind: "decision"; decision: PolicyDecision } | { kind: "local"; plan: LocalPolicyPlan });
const decisionSchema = z.object({ decision: z.enum(["allow", "deny", "review"]), reason: z.string().trim().min(1).max(1000) }).strict();

export function policySwitches(rbac: unknown): PolicySwitches {
  const settings = rbac && typeof rbac === "object" ? rbac as Record<string, unknown> : {};
  return { remote: settings.enabled === true, local: settings.localPolicyAgentEnabled === true };
}

/** Only transport/service availability failures permit local fallback. A
 * denial, malformed contract/response, authentication error or cancellation does not. */
export function remotePolicyUnavailable(error: unknown): boolean {
  if (error instanceof OperationDeadlineExceeded) return true;
  if (!(error instanceof Error) || error.name === "AbortError") return false;
  const detail = error as Error & { status?: number; statusCode?: number; code?: string; cause?: { code?: string } };
  const message = error.message.toLowerCase();
  if (/unauthori[sz]ed|forbidden|denied|invalid|malformed|schema|contract|401|403/.test(message)) return false;
  if ([429, 502, 503, 504].includes(detail.statusCode ?? detail.status ?? 0)) return true;
  if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(detail.code ?? detail.cause?.code ?? "")) return true;
  return /\btimeout\b|timed out|fetch failed|network error|session is closed|service unavailable/.test(message);
}

/** Four combinations, one remote attempt, at most one local-model attempt. */
export async function choosePolicyCheck(settings: PolicySwitches, remote: () => Promise<PolicyDecision>, local: () => Promise<PolicyDecision>, signal?: AbortSignal): Promise<PolicyDecision> {
  if (signal?.aborted) return { decision: "deny", source: "skipped", reason: "Policy check cancelled." };
  if (settings.remote) {
    const result = await remote();
    if (signal?.aborted) return { decision: "deny", source: result.source, reason: "Policy check cancelled." };
    if (result.decision !== "unavailable" || !settings.local) return result;
    return { ...await local(), fallbackUsed: true };
  }
  return settings.local ? local() : { decision: "allow", source: "skipped", reason: "Additional policy checks are off; mandatory safeguards remain enforced." };
}

async function checkRemote(services: HandlerServices, user: CurrentUser, input: PolicyRequest): Promise<PolicyDecision> {
  if (directRagConfigured(services.config)) return checkDirectRagPolicy(services.config, user, input);
  const source = "erpbridge" as const, session = services.erpbridgeSession;
  if (!session || session.available === false) return { decision: "unavailable", source, reason: "ERPBridge policy checker is not connected." };
  // These two server-owned adapters have explicit argument contracts. Never
  // let a model invent a policy tool, supply an actor or bypass business dispatch.
  const tools = services.registries.snapshot().tools;
  const matches = tools.filter(tool => ["policy-gate-evaluate", "check_policy"].includes(tool.mcp_tool_name) &&
    (!tool.connection_id || tool.connection_id === (session.connectionId ?? "erpbridge-default")));
  const tool = matches.find(tool => tool.mcp_tool_name === "policy-gate-evaluate") ?? matches[0];
  if (!tool) return { decision: "unavailable", source, reason: "No reviewed ERPBridge policy-checker contract is configured." };
  if (matches.filter(item => item.mcp_tool_name === tool.mcp_tool_name).length !== 1 || !tool.bridge_contract || !tool.is_read_only ||
      !toolRoleAllowed(tool.allowed_roles, user.role) || hasReservedBridgeRole(tool))
    return { decision: "deny", source, reason: "ERPBridge policy-checker contract or role grant is invalid." };
  const args = tool.mcp_tool_name === "check_policy"
    ? { tool_name: input.action, user_id: user.id, user_role: user.role, arguments: { prompt: input.prompt, ...input.context } }
    : { actor: { user_id: user.id, role: user.role }, prompt: input.prompt, context: { ...input.context, action: input.action } };
  if (validateToolInput(tool.input_schema, args).length) return { decision: "deny", source, reason: "ERPBridge policy-checker input does not match its reviewed contract." };
  try {
    // Soft handoff only. Aborting this SDK request would close the shared MCP
    // session and break subsequent ERP calls. The SDK still owns its bounded
    // read-only transport; boundedOperation observes and fences late results.
    const raw = await boundedOperation(() => session.callToolDirect(tool.mcp_tool_name, args, input.signal), {
      timeoutMs: REMOTE_POLICY_HANDOFF_MS, label: "ERPBridge optional policy", signal: input.signal,
    });
    const result = interpretPolicyResponse(raw);
    return { decision: result.decision, source, reason: (result.reason || (result.allowed ? "ERPBridge policy check allowed this request." : result.decision === "review" ? "ERPBridge policy check requires review before execution." : "ERPBridge policy check denied this request.")).slice(0, 1000) };
  } catch (error) {
    return { decision: remotePolicyUnavailable(error) ? "unavailable" : "deny", source,
      reason: input.signal?.aborted ? "Policy check cancelled." : remotePolicyUnavailable(error) ? "ERPBridge policy checker is temporarily unavailable." : "ERPBridge policy check failed safely; no operation was approved." };
  }
}

async function prepareLocalPolicy(services: HandlerServices, user: CurrentUser, input: PolicyRequest): Promise<
  ({ kind: "decision"; decision: PolicyDecision } | { kind: "local"; plan: LocalPolicyPlan })> {
  const source = "local_model" as const;
  try {
    const raw = await readFile(services.config.governanceFallbackPolicyPath, "utf8");
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error("Policy file is too large");
    const policy = fallbackPolicySchema.parse(JSON.parse(raw));
    const role = policy.role_access[user.role] ?? policy.role_access.default;
    const metadata = { policyVersion: policy.version, policyHash: createHash("sha256").update(raw).digest("hex"), promptTemplateVersion: "prompt/local-policy/v2" as const };
    const actions = Array.isArray(input.context?.actions) ? input.context.actions.filter((value): value is string => typeof value === "string") : [input.action];
    if (!role || role.blocked_tools.includes("*") || actions.some(action => policy.globally_blocked_tools.includes(action) || role.blocked_tools.includes(action)))
      return { kind: "decision", decision: { decision: "deny", source, reason: "The local JSON policy blocks this role or action.", ...metadata } };
    if (actions.some(action => policy.tools_requiring_human_review.includes(action)))
      return { kind: "decision", decision: { decision: "review", source, reason: "The local JSON policy requires human review for this action.", ...metadata } };
    if (!services.providerRuntime?.configured) return { kind: "decision", decision: { decision: "unavailable", source, reason: "Configure a model before enabling the local policy agent.", ...metadata } };
    return { kind: "local", plan: { metadata,
      prompt: promptData({ policy, actor: { id: user.id, role: user.role }, request: input.prompt, action: input.action, context: input.context ?? {} }),
      context: { promptTemplateVersion: "prompt/local-policy/v2", actor: { id: user.id, role: user.role }, ...(input.traceId ? { traceId: input.traceId } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        maxOutputTokens: 1024, egress: { purpose: "interactive", dataClass: "restricted" } } } };
  } catch {
    return { kind: "decision", decision: { decision: "deny", source, reason: "The local policy JSON is missing or invalid. Nothing was approved.", failureCode: "LOCAL_POLICY_CONFIG_INVALID" } };
  }
}

/** Selection may await the existing remote checker, but never local inference. */
export async function prepareOptionalPolicy(services: HandlerServices, user: CurrentUser, input: PolicyRequest): Promise<PreparedOptionalPolicy> {
  const settings = await services.repository.read(state => policySwitches(state.settings.rbac));
  if (input.signal?.aborted) return { kind: "decision", settings, fallbackUsed: false, decision: { decision: "deny", source: "skipped", reason: "Policy check cancelled." } };
  if (settings.remote) {
    const decision = await checkRemote(services, user, input);
    if (input.signal?.aborted || decision.decision !== "unavailable" || !settings.local)
      return { kind: "decision", settings, fallbackUsed: false, decision: input.signal?.aborted ? { decision: "deny", source: decision.source, reason: "Policy check cancelled." } : decision };
    const local = await prepareLocalPolicy(services, user, input);
    return { ...local, settings, fallbackUsed: true };
  }
  return settings.local ? { ...await prepareLocalPolicy(services, user, input), settings, fallbackUsed: false }
    : { kind: "decision", settings, fallbackUsed: false, decision: { decision: "allow", source: "skipped", reason: "Additional policy checks are off; mandatory safeguards remain enforced." } };
}

export async function assertLocalPolicyCurrent(path: string, plan: { metadata: Pick<PolicyDecision, "policyHash"> }): Promise<void> {
  const raw = await readFile(path);
  if (raw.byteLength > 64 * 1024 || createHash("sha256").update(raw).digest("hex") !== plan.metadata.policyHash)
    throw new Error("Original local policy file changed during checking");
}

/** Bounded, denial-only file check at the synchronous SDK authorization edge. */
export function assertLocalPolicyCurrentSync(path: string, policyHash: string): void {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd), limit = 64 * 1024;
    if (!stat.isFile() || stat.size > limit) throw new Error("Original local policy file changed during checking");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0, count: number;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length > limit || createHash("sha256").update(bytes.subarray(0, length)).digest("hex") !== policyHash)
      throw new Error("Original local policy file changed during checking");
  } finally { closeSync(fd); }
}

/** Pure interpretation shared by the resident evaluator and detached task wait. */
export function interpretLocalPolicy(plan: LocalPolicyPlan, response: AnalysisResponse | undefined, failure?: unknown, cancelled = false): PolicyDecision {
  const source = "local_model" as const, metadata = plan.metadata;
  let generationDiagnostics = response?.generationDiagnostics ?? (failure instanceof OpenAICompatibleError ? failure.generationDiagnostics : undefined);
  if (cancelled) return response ? { decision: "deny", source, reason: "Policy check cancelled.", ...metadata }
    : { decision: "deny", source, reason: "Policy check cancelled.", failureCode: "POLICY_CHECK_CANCELLED" };
  try {
    if (!response) throw failure;
    if (generationDiagnostics?.finishReason === "length") throw new Error("Policy response exhausted its output budget");
    if (response.text.length > 8000) throw new Error("Policy decision is too large");
    const result = decisionSchema.parse(JSON.parse(response.text));
    return { ...result, source, ...metadata, model: response.model, ...(generationDiagnostics ? { generationDiagnostics } : {}) };
  } catch (error) {
    generationDiagnostics ??= error instanceof OpenAICompatibleError ? error.generationDiagnostics : undefined;
    if (response || error instanceof OpenAICompatibleError && error.kind === "malformed")
      return { decision: "deny", source, reason: "The selected model returned invalid or incomplete policy JSON. Nothing was approved; check the model response profile and budget.", failureCode: "LOCAL_POLICY_RESPONSE_INVALID", ...metadata,
        ...(generationDiagnostics ? { generationDiagnostics } : {}) };
    // Only typed transport metadata is public. Arbitrary exception messages can
    // contain credentials, provider payloads or storage internals.
    const detail = error instanceof OpenAICompatibleError ? ` (${error.kind}${error.statusCode ? `, HTTP ${error.statusCode}` : ""})` : "";
    return { decision: "deny", source, reason: `The selected model could not complete the local policy check${detail}. Nothing was approved.`, failureCode: "LOCAL_POLICY_PROVIDER_FAILED" };
  }
}

async function checkLocal(services: HandlerServices, user: CurrentUser, input: PolicyRequest): Promise<PolicyDecision> {
  const prepared = await prepareLocalPolicy(services, user, input);
  if (prepared.kind === "decision") return prepared.decision;
  let response: AnalysisResponse | undefined, failure: unknown;
  try { response = await services.providerRuntime!.generate(prepared.plan.prompt, "prompt/local-policy/v2", input.signal, "", prepared.plan.context); }
  catch (error) { failure = error; }
  return interpretLocalPolicy(prepared.plan, response, failure, input.signal?.aborted === true);
}

export function finalOptionalPolicy(state: Readonly<RepositoryState>, user: CurrentUser, settings: PolicySwitches, result: PolicyDecision, cancelled = false): PolicyDecision {
  const current = effectiveUserFromState(state, user.id), latest = policySwitches(state.settings.rbac);
  return cancelled || !current || current.status.toLowerCase() !== "active" || current.role !== user.role ||
      JSON.stringify([...current.permissions].sort()) !== JSON.stringify([...user.permissions].sort()) || JSON.stringify(settings) !== JSON.stringify(latest)
    ? { decision: "deny", source: result.source, reason: "Policy settings or actor changed during checking. Retry the request after reviewing the current settings." } : result;
}

export function appendOptionalPolicyAudit(state: RepositoryState, user: CurrentUser, final: PolicyDecision, input: Pick<PolicyRequest, "traceId" | "sessionId">): void {
  if (final.source === "skipped") return;
  const after: Record<string, unknown> = { decision: final.decision, source: final.source };
  if (["LOCAL_POLICY_CONFIG_INVALID", "LOCAL_POLICY_PROVIDER_FAILED", "LOCAL_POLICY_RESPONSE_INVALID", "POLICY_CHECK_CANCELLED"].includes(final.failureCode ?? "")) after.failureCode = final.failureCode;
  state.auditLogs.push({ id: `audit_${state.auditLogs.length + 1}`, action: "optional_policy.evaluated", source: "optional-policy-ts", resource: { type: "optional_policy", id: "final-decision" },
    before: null, after, actor: { id: user.id, role: user.role }, createdAt: new Date().toISOString(),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }), ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }) });
}

/** Additional denial-only preflight. It never issues an execution token. */
export async function evaluateOptionalPolicy(services: HandlerServices, user: CurrentUser, input: PolicyRequest): Promise<PolicyDecision> {
  const settings = await services.repository.read(state => policySwitches(state.settings.rbac));
  const result = await choosePolicyCheck(settings, () => checkRemote(services, user, input), () => checkLocal(services, user, input), input.signal);
  if (result.source === "skipped") return result;
  const final = await services.repository.read(state => finalOptionalPolicy(state, user, settings, result, input.signal?.aborted === true));
  // Diagnostic evidence only, never a token or dispatch grant. An uncertain
  // audit acknowledgement must propagate outside provider/policy catches.
  await services.repository.mutate(state => {
    appendOptionalPolicyAudit(state, user, final, input);
  });
  return final;
}
