import { toolRoleAllowed } from "../../governance/tool-access.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ok } from "../../models/schemas.js";
import { runErpChatLoop } from "../../agent/erp-chat-loop.js";
import { administratorChatEnabled, administratorChatRoleEnabled, administratorChatEvidence, executeAdministratorChatAction, getAdministratorChatAction, proposeAdministratorChatAction } from "../../tools/admin-erp-actions.js";
import { evaluateOptionalPolicy } from "../../governance/optional-policy.js";
import { assertChatAuthority } from "./model-selection.js";
import { bodyRecord, HandlerFailure, nextID, now, requestParam, type CurrentUser, type HandlerServices } from "./common.js";
import { workspaceStatusAnswer } from "../../agent/chat-workspace-status.js";
import type { RepositoryState } from "../../repository/store.js";
import type { processStoredChat } from "./chat.js";
import { LIBRARY_READ_TOOLS, libraryModelInputSchema } from "../../documents/library-client.js";
import { dispatchReadTool } from "../../tools/read-tool-broker.js";
import { directLibraryCatalog, dispatchDirectLibraryRead } from "../../documents/direct-library.js";
import { discoverTools } from "../../agent/tool-discovery.js";
import type { ErpbridgeMcpSdkTool } from "../../tools/erpbridge-mcp-client.js";

type Input = Parameters<typeof processStoredChat>[0];
export { administratorChatEnabled, administratorChatRoleEnabled };

/** Discovery needs no model inference and must not mistake an unavailable
 * connection for an absent admin role grant. This grants no ERP dispatch. */
export async function processAdministratorCapabilities(input: Input, mutate: <T>(action: (state: RepositoryState) => T) => Promise<T>) {
  const { services, user, sessionId, stored, traceId, signal } = input;
  const assertAdmin = (state: Readonly<RepositoryState>) => {
    assertChatAuthority(state, user, sessionId);
    if (!administratorChatRoleEnabled(services, user) || state.users[user.id]?.roleId !== "role_admin" || state.roles.role_admin?.name !== "Platform Admin")
      throw new HandlerFailure(403, "Current built-in administrator authority is required");
  };
  await services.repository.readAuthoritative(assertAdmin);
  let tools: Awaited<ReturnType<NonNullable<HandlerServices["erpbridgeSession"]>["listTools"]>> = [], code: string | undefined;
  if (!services.erpbridgeSession || services.erpbridgeSession.available === false) code = "ERPBRIDGE_NOT_CONNECTED";
  else try { tools = await services.erpbridgeSession.listTools(signal); }
    catch { code = "ERPBRIDGE_DISCOVERY_UNAVAILABLE"; }
  const reads = tools.filter(tool => tool.annotations?.readOnlyHint === true), changes = tools.filter(tool => tool.annotations?.readOnlyHint !== true);
  const names = (values: typeof tools) => values.map(tool => `\`${tool.name.replace(/[^A-Za-z0-9_.:/-]/g, " ")}\``).join(", ");
  const text = code ? "Your Super Admin access is enabled, but the ERPBridge connection is currently unavailable. This is a connection problem, not a missing role permission. Check Settings → ERP connections and try the lookup again when it is connected. No ERP operation was performed." :
    !tools.length ? "Your Super Admin access is enabled, but the connected ERPBridge token currently exposes no tools. Check the token's access on ERPBridge. No ERP operation was performed." :
    `Your Super Admin ERP connection currently exposes **${tools.length} capabilities**: ${reads.length} lookups and ${changes.length} changes or other operations.\n\n` +
    (reads.length ? `Lookup tools (complete list): ${names(reads)}.\n\n` : "") + (changes.length ? `Change and other tools (complete list): ${names(changes)}.\n\n` : "") +
    "Describe what you need in plain English. I can look up data and prepare supported changes in this chat; a separate workflow is only needed when you ask for one. Review and confirm the exact change before it is sent. Required fields and the ERP token's own permissions still apply.\n\nThis checked the tool catalog only; it did not read or change ERP business records.";
  const assistantMessage = await mutate(state => {
    assertAdmin(state); const chat = state.chats[sessionId]!;
    const message = { id: nextID(state, "msg"), role: "assistant", text, createdAt: now(), traceId,
      artifacts: { intent: "CAPABILITIES", ...(code ? { code, blocked: true } : {}), capabilities: { offeredCount: tools.length,
        readOnlyCount: reads.length, changeCount: changes.length, accessMode: "administrator-token",
        tools: tools.map(tool => ({ name: tool.name, readOnly: tool.annotations?.readOnlyHint === true })) }, toolsDispatched: false } };
    chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now(); return message;
  });
  return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage, answer: text, intent: "CAPABILITIES" }, "ERP catalog checked; no business operation performed", null);
}
export async function chatErpActionRoute(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices, execute: boolean) {
  const sessionId = requestParam(request, "id"), id = requestParam(request, "actionId");
  const result = execute ? await executeAdministratorChatAction(services, user, sessionId, id, bodyRecord(request)) : await getAdministratorChatAction(services, user, sessionId, id);
  return reply.send(ok(result, "Current ERP action evidence loaded; uncertain changes are never replayed", null));
}

export async function processBackendAgentChat(input: Input, intent: string, mutate: <T>(action: (state: RepositoryState) => T) => Promise<T>, context?: string) {
  const { services, user, sessionId, stored, content, traceId, signal, hooks } = input;
  let session = services.erpbridgeSession, admin = administratorChatEnabled(services, user);
  const library = directLibraryCatalog(services);
  const loadErpCatalog = async (): Promise<ErpbridgeMcpSdkTool[]> => {
    await services.mcpConnectionRuntime?.ensureSession();
    session = services.erpbridgeSession; admin = administratorChatEnabled(services, user);
    if (!session || session.available === false) return [];
    const found = admin ? [...await session.listTools(signal)] : (await discoverTools(session, services.registries))
      .filter(tool => tool.is_read_only && toolRoleAllowed(tool.allowed_roles, user.role))
      .map(tool => ({ name: tool.mcp_tool_name, description: tool.description, inputSchema: tool.input_schema, annotations: { readOnlyHint: true } }));
    return found.filter(tool => !library.length || !LIBRARY_READ_TOOLS.has(tool.name));
  };
  // Do not wait on bridge discovery merely to query the document pipeline.
  // The agent loads ERP contracts only when selecting its ERP skill.
  const erp = library.length ? [] : await loadErpCatalog();
  // Direct backend skills replace only the library names, never ERP effects.
  // Existing bridge bindings remain usable when no direct pipeline is set.
  const catalog = [...erp.filter(tool => !library.length || !LIBRARY_READ_TOOLS.has(tool.name)), ...library]
    .filter(tool => !LIBRARY_READ_TOOLS.has(tool.name) || tool.annotations?.readOnlyHint === true)
    .map(tool => LIBRARY_READ_TOOLS.has(tool.name) ? { ...tool, inputSchema: libraryModelInputSchema({ mcp_tool_name: tool.name, input_schema: tool.inputSchema }) } : tool);
  const evidence = admin ? await administratorChatEvidence(services, user, sessionId) : [];
  const requestContext = JSON.stringify({ reviewedDocument: context ?? null, recordedErpActions: evidence,
    selectedNodeReference: input.body?.nodeContext ?? null }).slice(0, 32_000);
  const result = await runErpChatLoop({ content, history: stored.priorMessages, context: requestContext, actorId: user.id, role: user.role, sessionId, traceId, signal,
      onTurn: hooks ? () => hooks.stage("MODEL") : undefined, catalog, ...(library.length ? { loadErpCatalog } : {}),
    read: async (tool, args) => {
      if (LIBRARY_READ_TOOLS.has(tool.name)) {
        if (library.length) {
          const dispatch = (beforeDispatch: () => Promise<void>) => dispatchDirectLibraryRead(services, user, sessionId, tool.name, args, { signal, traceId, beforeDispatch });
          return hooks ? hooks.read(tool.name, args, checkpoint => dispatch(() => checkpoint(user.role))) : dispatch(async () => {});
        }
        const dispatch = (beforeDispatch: () => Promise<void>) => dispatchReadTool(services, user.id, tool.name, args, { signal, traceId, sessionId, beforeDispatch });
        if (hooks) return hooks.read(tool.name, args, checkpoint => dispatch(() => checkpoint(user.role)));
        return dispatch(async () => { await services.repository.readAuthoritative(state => assertChatAuthority(state, user, sessionId)); });
      }
      if (!admin) return hooks ? hooks.read(tool.name, args, checkpoint => dispatchReadTool(services, user.id, tool.name, args, { signal, traceId, sessionId, beforeDispatch: () => checkpoint(user.role) }))
        : dispatchReadTool(services, user.id, tool.name, args, { signal, traceId, sessionId });
      if (tool.annotations?.readOnlyHint !== true) throw new HandlerFailure(403, "A current read-only tool declaration is required for ERP lookup");
      const policy = await evaluateOptionalPolicy(services, user, { prompt: content, action: tool.name, context: { arguments: args, readOnly: true }, signal, traceId, sessionId });
      if (policy.decision !== "allow") throw new HandlerFailure(409, "Current ERP read policy requires review");
        const dispatch = (beforeDispatch: () => Promise<void>) => session!.executeAdministratorTool!(tool, args, user.id, beforeDispatch, signal);
      if (hooks) return hooks.read(tool.name, args, checkpoint => dispatch(() => checkpoint(user.role)));
      return dispatch(async () => { await services.repository.readAuthoritative(state => assertChatAuthority(state, user, sessionId)); });
    },
    propose: async (tool, args) => {
      if (!admin || LIBRARY_READ_TOOLS.has(tool.name)) throw new HandlerFailure(403, "This skill cannot prepare an ERP change for the current actor");
      return proposeAdministratorChatAction(services, user, sessionId, String(stored.userMessage.id), content, tool, args,
        async () => { await hooks?.beforeCommit?.(); await services.repository.readAuthoritative(state => { hooks?.assertCurrent(state as RepositoryState); assertChatAuthority(state, user, sessionId); }); });
    },
  }, services.providerRuntime!);
  const assistantMessage = await mutate(state => {
    const chat = assertChatAuthority(state, user, sessionId);
    const message = { id: nextID(state, "msg"), role: "assistant", modelBinding: services.providerRuntime!.binding, createdAt: now(), traceId,
      ...workspaceStatusAnswer(state, user, sessionId, result.text, { intent, toolSteps: result.toolSteps, erpActionProposals: result.erpActionProposals,
        ...(result.visualisation ? { visualisation: result.visualisation } : {}),
        blocked: result.blocked, toolsDispatched: result.toolSteps.length > 0, workflowGenerated: false }) };
    chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now(); return message;
  });
  return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage, answer: assistantMessage.text, intent, usage: result.usage }, "Conversation processed; no workflow generated", null);
}

// Preserve the historical internal entry point for integrations/fixtures.
export const processAdministratorErpChat = processBackendAgentChat;
