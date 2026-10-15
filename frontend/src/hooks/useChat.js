import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { chatService } from "../services/chat.service";
import { useAuthContext } from "../context/AuthContext";
import { acknowledgeChatCommand, prepareChatCommand } from "../utils/chatCommand";
import { isActiveChatOperation, useChatOperationMonitor } from "./useChatOperationMonitor";
import { requireChatCapability, requireChatReceipt } from "../utils/chatAdmission";
import { authorityScope, captureAuthority, isAuthorityCurrent, staleAuthorityError } from "../utils/authAuthority";
import { chatQueryKeys } from "../utils/chatQueryKeys";

const deniedStatus = error => [401, 403, 404].includes(error?.response?.status);

export function useChat(sessionId) {
  const queryClient = useQueryClient();
  const { user } = useAuthContext();
  const scope = authorityScope(user);
  // Scope changes only when actor, role, permissions, or epoch changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const capture = useMemo(() => captureAuthority(user), [scope]);
  const [identityFailure, setIdentityFailure] = useState(null);
  const sessionKey = useMemo(() => chatQueryKeys.session(scope, sessionId), [scope, sessionId]);
  const operationsKey = useMemo(() => chatQueryKeys.operations(scope, sessionId), [scope, sessionId]);

  const operations = useQuery({
    queryKey: operationsKey,
    enabled: Boolean(sessionId && user && scope),
    // Active progress has its own cursor monitor. Do not keep rereading the
    // operation list while that monitor is running or after a saved answer.
    refetchInterval: false,
    queryFn: async ({ signal }) => {
      if (!isAuthorityCurrent(capture)) throw staleAuthorityError();
      const data = await chatService.operations(sessionId, { signal });
      if (!isAuthorityCurrent(capture)) throw staleAuthorityError();
      return data;
    },
  });
  const latestOperation = operations.data?.[0];

  const cancelMutation = useMutation({
    mutationFn: async ({ id, request }) => {
      if (!isAuthorityCurrent(request)) throw staleAuthorityError();
      const result = await chatService.cancelOperation(id);
      if (!isAuthorityCurrent(request)) throw staleAuthorityError();
      return result;
    },
    onSuccess: (_result, variables) => {
      if (!isAuthorityCurrent(variables.request)) return;
      monitor.refresh();
      void operations.refetch();
    },
  });

  const session = useQuery({
    queryKey: sessionKey,
    enabled: Boolean(sessionId && user && scope),
    queryFn: async ({ signal }) => {
      if (!isAuthorityCurrent(capture)) throw staleAuthorityError();
      const data = await chatService.getSession(sessionId, { limit: 20, signal });
      if (!isAuthorityCurrent(capture)) throw staleAuthorityError();
      const saved = queryClient.getQueryData(sessionKey);
      if (!saved?.messages?.length) return data;
      const first = saved.messages.findIndex(message => message.id === data.messages?.[0]?.id);
      const prefix = first >= 0 ? saved.messages.slice(0, first) : saved.messages;
      return { ...data, messages: [...new Map([...prefix, ...(data.messages || [])].map(message => [message.id, message])).values()], hasMoreMessages: saved.hasMoreMessages === false ? false : Boolean(data.hasMoreMessages) };
    },
  });
  const readDenied = deniedStatus(operations.error) || deniedStatus(session.error);
  const monitor = useChatOperationMonitor(readDenied ? undefined : latestOperation?.id, { scope });
  const accessDenied = readDenied || monitor.denied;
  const operation = accessDenied ? null : monitor.operation || latestOperation || null;
  const operationId = operation?.id;
  const operationStatus = operation?.status;
  const assistantMessageId = operation?.assistantMessageId;
  const reconciledTerminal = useRef("");

  useEffect(() => {
    if (!isAuthorityCurrent(capture)) return;
    if (assistantMessageId || (operationId && !isActiveChatOperation(operationStatus))) {
      const key = `${scope}:${operationId}:${operationStatus}:${assistantMessageId || "pending-answer"}`;
      if (reconciledTerminal.current === key) return;
      reconciledTerminal.current = key;
      let disposed = false;
      void (async () => {
        const attempts = operationStatus === "ANSWERED" ? 3 : 1;
        for (let attempt = 0; attempt < attempts && !disposed && isAuthorityCurrent(capture); attempt++) {
          if (attempt > 0) await new Promise(resolve => setTimeout(resolve, attempt * 300));
          if (disposed || !isAuthorityCurrent(capture)) return;
          await session.refetch();
          const saved = queryClient.getQueryData(sessionKey);
          if (operationStatus !== "ANSWERED" || saved?.messages?.some(message =>
            message.role === "assistant" && (assistantMessageId ? message.id === assistantMessageId : message.operationId === operationId))) break;
        }
        if (!disposed && isAuthorityCurrent(capture)) {
          void queryClient.invalidateQueries({ queryKey: chatQueryKeys.sessions(scope) });
          void queryClient.invalidateQueries({ queryKey: ["workflows", scope] });
        }
      })();
      return () => { disposed = true; };
    }
  }, [assistantMessageId, capture, operationId, operationStatus, queryClient, scope, session, sessionKey]);

  const sendMutation = useMutation({
    mutationFn: async ({ target, text, options, request }) => {
      if (!isAuthorityCurrent(request)) throw staleAuthorityError();
      if (options.delivery === "async-chat") {
        try {
          const capabilities = await chatService.capabilities();
          if (!isAuthorityCurrent(request)) throw staleAuthorityError();
          requireChatCapability(capabilities, options);
        } catch (error) {
          if (error.code !== "ERR_STALE_AUTHORITY") error.beforeAdmission = true;
          throw error;
        }
      }
      if (!isAuthorityCurrent(request)) throw staleAuthorityError();
      const result = await chatService.sendMessage(target, text, options);
      if (!isAuthorityCurrent(request)) throw staleAuthorityError();
      return options.delivery === "async-chat" ? requireChatReceipt(result, target, options, text) : result;
    },
    onSuccess: async (result, variables) => {
      const request = variables.request;
      if (!isAuthorityCurrent(request)) return;
      const targetSessionKey = chatQueryKeys.session(variables.scope, variables.target);
      const targetOperationsKey = chatQueryKeys.operations(variables.scope, variables.target);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: targetSessionKey }),
        queryClient.cancelQueries({ queryKey: targetOperationsKey }),
      ]);
      if (!isAuthorityCurrent(request)) return;
      queryClient.setQueryData(targetSessionKey, (current = {}) => ({
        ...current,
        ...(result.session || {}),
        messages: [...new Map([...(current.messages || []), result.userMessage, result.assistantMessage].filter(Boolean).map(message => [message.id, message])).values()],
      }));
      if (variables.command && isAuthorityCurrent(request)) acknowledgeChatCommand(variables.command);
      if (result.operation && isAuthorityCurrent(request)) {
        queryClient.setQueryData(targetOperationsKey, (current = []) => [result.operation, ...current.filter(entry => entry.id !== result.operation.id)]);
      }
      if (!isAuthorityCurrent(request)) return;
      void queryClient.invalidateQueries({ queryKey: targetOperationsKey });
      void queryClient.invalidateQueries({ queryKey: chatQueryKeys.sessions(variables.scope) });
      void queryClient.invalidateQueries({ queryKey: ["workflows", variables.scope] });
    },
  });

  const resetSend = sendMutation.reset;
  useEffect(() => { resetSend(); }, [sessionId, resetSend]);

  const [pagination, setPagination] = useState({ scope: "", sessionId: "", loading: false, error: "" });
  const paginationCurrent = pagination.scope === scope && pagination.sessionId === sessionId;
  const loadingMore = paginationCurrent && pagination.loading;
  const paginationController = useRef(null);
  useEffect(() => () => paginationController.current?.abort(), [scope, sessionId]);
  const loadMore = useCallback(async () => {
    if (!isAuthorityCurrent(capture) || paginationController.current && !paginationController.current.signal.aborted) return;
    const current = queryClient.getQueryData(sessionKey);
    const oldest = current?.messages?.[0];
    if (!sessionId || !oldest || !current?.hasMoreMessages || loadingMore) return;
    const controller = new AbortController();
    paginationController.current = controller;
    setPagination({ scope, sessionId, loading: true, error: "" });
    try {
      const older = await chatService.getSession(sessionId, { limit: 20, before: oldest.id, signal: controller.signal });
      if (!isAuthorityCurrent(capture) || controller.signal.aborted) return;
      if (older.id !== sessionId) throw new Error("Earlier message identity could not be verified. Reload this conversation.");
      await queryClient.cancelQueries({ queryKey: sessionKey });
      if (!isAuthorityCurrent(capture) || controller.signal.aborted) return;
      queryClient.setQueryData(sessionKey, (curr = {}) => ({
        ...curr,
        messages: [...new Map([...(older.messages || []), ...(curr.messages || [])].map(message => [message.id, message])).values()],
        hasMoreMessages: Boolean(older.hasMoreMessages),
      }));
    } catch (error) {
      if (isAuthorityCurrent(capture) && !controller.signal.aborted) setPagination({ scope, sessionId, loading: false, error: error?.response?.data?.message || "Earlier messages could not be loaded. Try again; your conversation is kept." });
    } finally {
      if (paginationController.current === controller) { paginationController.current = null; if (isAuthorityCurrent(capture)) setPagination(value => ({ ...value, loading: false })); }
    }
  }, [capture, loadingMore, queryClient, scope, sessionId, sessionKey]);

  const send = useCallback(async (text, overrideSessionId, options = {}) => {
    const request = capture;
    const requestScope = scope;
    const target = overrideSessionId || sessionId;
    if (!target || !text.trim() || !isAuthorityCurrent(request)) return null;
    setIdentityFailure(null);
    let command;
    try {
      command = options.emailDraftCommand ? null : await prepareChatCommand(user, target, text.trim(), options, () => isAuthorityCurrent(request));
      if (!isAuthorityCurrent(request)) return null;
    } catch (error) {
      if (isAuthorityCurrent(request)) setIdentityFailure({ target, scope: requestScope, message: error.message });
      return null;
    }
    try {
      const result = await sendMutation.mutateAsync({
        target,
        text: text.trim(),
        command,
        options: command ? { ...options, delivery: "async-chat", idempotencyKey: command.key } : options,
        request,
        scope: requestScope,
      });
      return isAuthorityCurrent(request) ? result : null;
    } catch (error) {
      if (!isAuthorityCurrent(request)) return null;
      if (!error?.response && error.code !== "ERR_STALE_AUTHORITY") {
        setIdentityFailure({ target, scope: requestScope, message: error.beforeAdmission ? "Saved chat admission could not be verified. No message was sent. Check the server connection and version; your draft is kept." : "Acknowledgement was not confirmed. Your draft is kept. Retry the same message to retrieve its saved operation; it will not be admitted twice." });
      }
      void queryClient.invalidateQueries({ queryKey: chatQueryKeys.operations(requestScope, target) });
      return null;
    }
  }, [capture, queryClient, scope, sendMutation, sessionId, user]);

  const denied = accessDenied;
  const messages = useMemo(() => denied ? [] : session.data?.messages || [], [denied, session.data?.messages]);
  const artifact = useMemo(() => denied ? null : [...messages].reverse().find(message => message.artifacts)?.artifacts || null, [denied, messages]);
  const sessionError = denied || messages.length === 0 ? session.error : null;
  const sendBelongsToScope = sendMutation.variables?.scope === scope && isAuthorityCurrent(sendMutation.variables?.request);
  const sendError = sendBelongsToScope && sendMutation.error?.code !== "ERR_STALE_AUTHORITY" ? sendMutation.error : null;
  const cancelBelongsToScope = isAuthorityCurrent(cancelMutation.variables?.request);
  const error = sendError || sessionError || (denied ? operations.error : null);

  return {
    accessDenied: denied,
    readOnly: !denied && session.data?.access?.reviewOnly === true,
    selectedModel: denied ? "" : session.data?.selectedModel || "",
    messages,
    workflowCatalog: denied || !Array.isArray(session.data?.workflowCatalog) ? [] : session.data.workflowCatalog,
    artifact,
    loading: (sendMutation.isPending && sendMutation.variables?.scope === scope) || Boolean(operation && isActiveChatOperation(operation.status)),
    sessionLoading: Boolean(sessionId && !accessDenied && session.isPending),
    sessionRefreshing: Boolean(sessionId && !accessDenied && session.isFetching && !session.isPending),
    reloadConversation: () => { if (isAuthorityCurrent(capture)) { void session.refetch(); void operations.refetch(); } },
    error: (identityFailure?.scope === scope && identityFailure?.target === sessionId ? identityFailure.message : "") || error?.response?.data?.message || (error ? "Chat could not complete the request. Your draft is kept." : ""),
    operation,
    operationEvents: monitor.events,
    operationError: monitor.error || (cancelBelongsToScope && cancelMutation.error?.response?.data?.message) || (cancelBelongsToScope && cancelMutation.error ? "Cancellation was not acknowledged. Refresh saved progress before trying again." : ""),
    reconnecting: monitor.reconnecting,
    cancelOperation: () => operation && isAuthorityCurrent(capture) && cancelMutation.mutate({ id: operation.id, request: capture }),
    cancelling: cancelMutation.isPending && cancelBelongsToScope,
    refreshOperation: monitor.refresh,
    send,
    hasMoreMessages: denied ? false : Boolean(session.data?.hasMoreMessages),
    loadingMore,
    loadMore,
    loadMoreError: paginationCurrent ? pagination.error : "",
    totalMessages: session.data?.totalMessageCount,
  };
}

export default useChat;
