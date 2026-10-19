import { allRolesToolAccess } from "../governance/tool-access.js";
import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import type { RepositoryState } from "../repository/store.js";
import { appendAudit, HandlerFailure, isRecord, nextID, now, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import { assertChatAuthority } from "../http/handlers/model-selection.js";
import { captureUserMcpBinding, withUserMcpBinding, type UserCredentialBinding } from "./user-mcp-credentials.js";
import type { ErpbridgeMcpSdkTool } from "./erpbridge-mcp-client.js";
import { erpChatInputIssues } from "./erp-chat-input.js";
import { containsCredentials } from "../storage/firestore-native-fields.js";
import { evaluateOptionalPolicy } from "../governance/optional-policy.js";
import { erpBusinessActionLabel } from "../agent/erp-business-language.js";
import { formatEmailArguments } from "../delivery/branded-email.js";

type Action = {
  id: string; profile: "erp-chat-action/v1"; ownerId: string; sessionId: string; messageId: string;
  tool: ErpbridgeMcpSdkTool; arguments: Record<string, unknown>; prompt: string; connectionBinding: string;
  erpCredentialSecret?: UserCredentialBinding; createdAt: string; expiresAt: string; reviewHash: string;
  status: "PENDING" | "DISPATCH_INTENT" | "SUCCEEDED" | "FAILED" | "OUTCOME_UNKNOWN";
  decisionKey?: string; receipt?: Record<string, unknown>; completedAt?: string;
};
export type ErpChatActionView = ReturnType<typeof actionView>;
const commandSchema = z.object({ reviewHash: z.string().regex(/^[a-f0-9]{64}$/), decisionKey: z.string().uuid() }).strict();
const hash = (services: HandlerServices, value: unknown) => createHmac("sha256", services.config.storageEncryptionKey).update(canonicalJSONBytes(value)).digest("hex");
const actions = (state: Readonly<RepositoryState>): Record<string, Action> => (state.settings.erpChatActions ?? {}) as Record<string, Action>;

export function administratorChatEnabled(services: HandlerServices, user: CurrentUser): boolean {
  return administratorChatRoleEnabled(services, user) &&
    typeof services.erpbridgeSession?.executeAdministratorTool === "function";
}
export function administratorChatRoleEnabled(services: HandlerServices, user: CurrentUser): boolean {
  return services.config.erpbridgeAdminChatActions === true && (allRolesToolAccess() || user.roleId === "role_admin" && user.role === "Platform Admin");
}
function authority(services: HandlerServices, state: Readonly<RepositoryState>, user: CurrentUser, sessionId: string) {
  if (!administratorChatEnabled(services, user)) throw new HandlerFailure(403, "Administrator chat actions are not enabled for this account");
  assertChatAuthority(state, user, sessionId);
  if (!allRolesToolAccess() && (state.users[user.id]?.roleId !== "role_admin" || state.roles.role_admin?.name !== "Platform Admin")) throw new HandlerFailure(403, "Administrator authority changed");
}
function bindingValue(action: Action) {
  return { profile: action.profile, id: action.id, ownerId: action.ownerId, sessionId: action.sessionId, messageId: action.messageId,
    tool: action.tool, arguments: action.arguments, prompt: action.prompt, connectionBinding: action.connectionBinding,
    erpCredentialSecret: action.erpCredentialSecret ?? null, createdAt: action.createdAt, expiresAt: action.expiresAt };
}
function actionView(action: Action) {
  return { profile: action.profile, id: action.id, ownerId: action.ownerId, sessionId: action.sessionId, toolName: action.tool.name,
    arguments: structuredClone(action.arguments), reviewHash: action.reviewHash, status: action.status, createdAt: action.createdAt,
    expiresAt: action.expiresAt, ...(action.receipt ? { receipt: structuredClone(action.receipt) } : {}) };
}
export async function getAdministratorChatAction(services: HandlerServices, user: CurrentUser, sessionId: string, id: string) {
  return services.repository.readAuthoritative(state => {
    authority(services, state, user, sessionId);
    const action = actions(state)[id];
    if (!action || action.ownerId !== user.id || action.sessionId !== sessionId) throw new HandlerFailure(404, "ERP chat action not found");
    return actionView(action);
  });
}
export async function administratorChatEvidence(services: HandlerServices, user: CurrentUser, sessionId: string) {
  return services.repository.readAuthoritative(state => {
    authority(services, state, user, sessionId);
    return Object.values(actions(state)).filter(action => action.ownerId === user.id && action.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4).map(action => ({ toolName: action.tool.name, status: action.status,
        arguments: action.arguments, receipt: action.receipt ?? null }));
  });
}

/** A proposal is durable conversation state, NOT a workflow, ERP dispatch or
 * approval. Exact contract, credential binding and inputs cannot be rebound. */
export async function proposeAdministratorChatAction(services: HandlerServices, user: CurrentUser, sessionId: string, messageId: string,
  prompt: string, tool: ErpbridgeMcpSdkTool, args: Record<string, unknown>, beforeCommit?: () => Promise<void>) {
  // Finalize outgoing presentation before validation, persistence and review.
  // Confirmation always dispatches these exact bytes, never re-renders later.
  args = formatEmailArguments(tool, args);
  if (tool.annotations?.readOnlyHint === true || erpChatInputIssues(tool, args).length || containsCredentials(args) ||
      canonicalJSONBytes(args).length > 64_000) throw new HandlerFailure(422, "ERP change arguments require valid, non-credential business fields");
  await beforeCommit?.();
  return services.repository.mutate(state => {
    authority(services, state, user, sessionId);
    if (!state.chats[sessionId]!.messages.some(message => message.id === messageId && message.role === "user")) throw new HandlerFailure(409, "Original chat request is unavailable");
    const records = actions(state);
    const existing = Object.values(records).find(action => action.sessionId === sessionId && action.messageId === messageId);
    if (existing) return actionView(existing);
    if (Object.values(records).some(action => action.ownerId === user.id && action.tool.name === tool.name &&
        ["DISPATCH_INTENT", "OUTCOME_UNKNOWN"].includes(action.status) && canonicalJSONBytes(action.arguments).equals(canonicalJSONBytes(args))))
      throw new HandlerFailure(409, "An identical ERP change has an unresolved outcome. Retrieve and reconcile the ERP record before preparing another change");
    if (Object.keys(records).length >= 5000) throw new HandlerFailure(409, "ERP action journal is full; archive review is required");
    const binding = captureUserMcpBinding(services, state, user.id);
    const action: Action = { id: `erpact_${randomUUID()}`, profile: "erp-chat-action/v1", ownerId: user.id, sessionId, messageId,
      tool: structuredClone(tool), arguments: structuredClone(args), prompt, connectionBinding: services.erpbridgeSession!.admissionBinding ?? "",
      ...(binding ? { erpCredentialSecret: binding } : {}), createdAt: now(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), status: "PENDING", reviewHash: "" };
    action.reviewHash = hash(services, bindingValue(action));
    state.settings.erpChatActions = { ...records, [action.id]: action };
    appendAudit(state, user, "erp_chat.proposed", "erp-chat-action", action.id, null, { toolName: tool.name, sessionId, status: "PENDING" });
    return actionView(action);
  });
}

/** This explicit human decision is the administrator self-approval boundary.
 * A durable dispatch intent precedes SDK entry; neither timeout nor a duplicate
 * confirmation may replay a write. Model prose never invokes this function. */
export async function executeAdministratorChatAction(services: HandlerServices, user: CurrentUser, sessionId: string, id: string, raw: unknown) {
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success) throw new HandlerFailure(400, "Confirm the exact reviewed ERP action with a decision identifier");
  const command = parsed.data;
  const action = await services.repository.readAuthoritative(state => {
    authority(services, state, user, sessionId);
    const stored = actions(state)[id];
    if (!stored || stored.sessionId !== sessionId || stored.ownerId !== user.id) throw new HandlerFailure(404, "ERP chat action not found");
    if (stored.reviewHash !== command.reviewHash || hash(services, bindingValue(stored)) !== stored.reviewHash) throw new HandlerFailure(409, "Reviewed ERP action changed");
    return structuredClone(stored);
  });
  if (action.status !== "PENDING") return actionView(action);
  if (Date.parse(action.expiresAt) <= Date.now()) throw new HandlerFailure(409, "ERP action expired. Ask for a new proposal");
  if (action.connectionBinding !== (services.erpbridgeSession!.admissionBinding ?? "")) throw new HandlerFailure(409, "ERP connection changed. Ask for a new proposal");
  const policy = await evaluateOptionalPolicy(services, user, { prompt: action.prompt, action: action.tool.name,
    context: { stage: "erp_chat_confirmation", arguments: action.arguments, exactReviewHash: action.reviewHash }, sessionId, traceId: action.id });
  if (policy.decision !== "allow") throw new HandlerFailure(409, `ERP action stopped by current policy: ${policy.reason}`);
  let entered = false;
  let receipt: Record<string, unknown> | undefined;
  try {
    receipt = await withUserMcpBinding(services, user.id, action.erpCredentialSecret, () => services.erpbridgeSession!.executeAdministratorTool!(action.tool,
      action.arguments, user.id, async () => services.repository.mutate(state => {
        authority(services, state, user, sessionId);
        const current = actions(state)[id];
        if (!current || current.status !== "PENDING" || hash(services, bindingValue(current)) !== command.reviewHash || Date.parse(current.expiresAt) <= Date.now())
          throw new HandlerFailure(409, "ERP action was changed, expired or already dispatched; it was not replayed");
        current.status = "DISPATCH_INTENT"; current.decisionKey = command.decisionKey;
        appendAudit(state, user, "erp_chat.dispatch_intent", "erp-chat-action", id, null, { toolName: action.tool.name, status: current.status, selfApproval: true });
      }).then(() => { entered = true; })));
  } catch (error) {
    if (!entered) throw error;
    // Once SDK entry was possible, even a transport/normalization error has an
    // unknown outcome. Persist evidence and never label this safe to retry.
  }
  return services.repository.mutate(state => {
    const current = actions(state)[id];
    if (!current || current.status !== "DISPATCH_INTENT" || current.decisionKey !== command.decisionKey) throw new HandlerFailure(409, "ERP outcome needs journal reconciliation");
    current.status = receipt ? receipt.isError === true ? "FAILED" : "SUCCEEDED" : "OUTCOME_UNKNOWN";
    current.completedAt = now();
    if (receipt) current.receipt = receipt;
    const chat = state.chats[sessionId];
    if (chat?.ownerId === user.id) {
      const label = erpBusinessActionLabel(action.tool.name, action.arguments);
      const text = current.status === "SUCCEEDED" ? `The ERP system acknowledged “${label}”. Its response is saved below. No workflow was generated.` :
        current.status === "FAILED" ? `The ERP system returned an error for “${label}”. Check the saved response before deciding what to do next. This action will not be automatically replayed.` :
          `The outcome of “${label}” is unconfirmed. Do not repeat this change blindly. Check the record in ERP to reconcile its current state.`;
      chat.messages.push({ id: nextID(state, "msg"), role: "assistant", text, createdAt: now(), artifacts: { intent: "TOOL_CALL", erpActionProposals: [actionView(current)] } });
      chat.messageCount = chat.messages.length; chat.updatedAt = now();
    }
    appendAudit(state, user, "erp_chat.result", "erp-chat-action", id, null, { toolName: action.tool.name, status: current.status });
    return actionView(current);
  });
}
