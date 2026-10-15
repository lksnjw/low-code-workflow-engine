import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { chatService } from "../services/chat.service";
import { useAuthContext } from "../context/AuthContext";
import { authorityScope, captureAuthority, isAuthorityCurrent, staleAuthorityError } from "../utils/authAuthority";
import { chatQueryKeys } from "../utils/chatQueryKeys";

const deniedStatus = error => [401, 403, 404].includes(error?.response?.status);

export function useChatSessions(initialSessionId = "", { autoSelect = true } = {}) {
  const queryClient = useQueryClient();
  const { user } = useAuthContext();
  const scope = authorityScope(user);
  const [selection, setSelection] = useState({ scope: "", id: "" });
  const [pagination, setPagination] = useState({ scope: "", loading: false, error: "" });
  const paginationController = useRef(null);
  const pageKey = useMemo(() => [...chatQueryKeys.sessions(scope), "pagination"], [scope]);
  useEffect(() => () => paginationController.current?.abort(), [scope]);
  // Scope changes only when actor, role, permissions, or epoch changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const capture = useMemo(() => captureAuthority(user), [scope]);
  const query = useQuery({
    queryKey: chatQueryKeys.sessions(scope),
    enabled: Boolean(user && scope),
    queryFn: async ({ signal }) => {
      if (!isAuthorityCurrent(capture)) throw staleAuthorityError();
      const pageCount = queryClient.getQueryData(pageKey)?.pagesLoaded || 1;
      let sessions = [], meta, after;
      for (let page = 1; page <= pageCount; page++) {
        const response = await chatService.listSessions({ signal, includePageMetadata: true, params: { page, limit: 20, ...(after ? {after} : {}) } });
        if (!isAuthorityCurrent(capture) || signal.aborted) throw staleAuthorityError();
        const items = Array.isArray(response) ? response : response.items;
        sessions.push(...items);
        const raw = response.meta;
        after=raw?.nextCursor;
        meta = { pagesLoaded: page, hasMore: Boolean(raw && (Object.hasOwn(raw,"nextCursor") ? raw.nextCursor : raw.page < raw.totalPages)), nextCursor:raw?.nextCursor, total: raw?.total ?? sessions.length };
        if (!meta.hasMore) break;
      }
      queryClient.setQueryData(pageKey, meta);
      return [...new Map(sessions.map(item => [item.id, item])).values()];
    },
  });
  const sessions = deniedStatus(query.error) ? [] : query.data || [];
  const selectedSessionId = initialSessionId || (selection.scope === scope ? selection.id : "") || (autoSelect ? sessions[0]?.id : "") || "";
  const page = deniedStatus(query.error) ? null : queryClient.getQueryData(pageKey);
  const loadMoreSessions = useCallback(async () => {
    if (!isAuthorityCurrent(capture) || paginationController.current && !paginationController.current.signal.aborted) return;
    const current = queryClient.getQueryData(pageKey);
    if (!current?.hasMore) return;
    const controller = new AbortController(); paginationController.current = controller;
    setPagination({ scope, loading: true, error: "" });
    try {
      const response = await chatService.listSessions({ signal: controller.signal, includePageMetadata: true, params: { page: current.pagesLoaded + 1, limit: 20, ...(current.nextCursor ? {after:current.nextCursor} : {}) } });
      if (!isAuthorityCurrent(capture) || controller.signal.aborted) return;
      const items = Array.isArray(response) ? response : response.items;
      queryClient.setQueryData(pageKey, { pagesLoaded: current.pagesLoaded + 1, hasMore: Boolean(response.meta && (Object.hasOwn(response.meta,"nextCursor") ? response.meta.nextCursor : response.meta.page < response.meta.totalPages)), nextCursor:response.meta?.nextCursor, total: response.meta?.total ?? current.total });
      queryClient.setQueryData(chatQueryKeys.sessions(scope), (old = []) => [...new Map([...old, ...items].map(item => [item.id, item])).values()]);
    } catch (error) {
      if (isAuthorityCurrent(capture) && !controller.signal.aborted) setPagination({ scope, loading: false, error: error?.response?.data?.message || "Older conversations could not be loaded. Try again; your current list is kept." });
    } finally {
      if (paginationController.current === controller) { paginationController.current = null; if (isAuthorityCurrent(capture)) setPagination(value => ({ ...value, loading: false })); }
    }
  }, [capture, pageKey, queryClient, scope]);

  const setSelectedSessionId = useCallback(id => {
    if (!isAuthorityCurrent(capture)) return;
    setSelection({ scope, id: id || "" });
  }, [capture, scope]);

  const createSession = useCallback(async (title, options) => {
    const request = capture;
    if (!isAuthorityCurrent(request)) throw staleAuthorityError();
    const created = await chatService.createSession(title, options);
    if (!isAuthorityCurrent(request)) throw staleAuthorityError();
    const key = chatQueryKeys.sessions(scope);
    await queryClient.cancelQueries({ queryKey: key });
    if (!isAuthorityCurrent(request)) throw staleAuthorityError();
    queryClient.setQueryData(key, (items = []) => [created, ...items.filter(item => item.id !== created.id)]);
    setSelection({ scope, id: created.id });
    return created;
  }, [capture, queryClient, scope]);

  const deleteSession = useCallback(async sessionId => {
    const request = capture;
    if (!isAuthorityCurrent(request)) throw staleAuthorityError();
    await chatService.deleteSession(sessionId);
    if (!isAuthorityCurrent(request)) throw staleAuthorityError();
    const key = chatQueryKeys.sessions(scope);
    await Promise.all([
      queryClient.cancelQueries({ queryKey: key }),
      queryClient.cancelQueries({ queryKey: chatQueryKeys.session(scope, sessionId) }),
      queryClient.cancelQueries({ queryKey: chatQueryKeys.operations(scope, sessionId) }),
    ]);
    if (!isAuthorityCurrent(request)) throw staleAuthorityError();
    queryClient.setQueryData(key, (items = []) => items.filter(item => item.id !== sessionId));
    queryClient.removeQueries({ queryKey: chatQueryKeys.session(scope, sessionId), exact: true });
    queryClient.removeQueries({ queryKey: chatQueryKeys.operations(scope, sessionId), exact: true });
    void queryClient.invalidateQueries({ queryKey: key, exact: true });
    if (selection.scope === scope && selection.id === sessionId) setSelection({ scope, id: "" });
  }, [capture, queryClient, scope, selection]);

  const renameSession = useCallback(async (sessionId, title) => {
    const request = capture;
    if (!isAuthorityCurrent(request)) throw staleAuthorityError();
    const updated = await chatService.updateSession(sessionId, title);
    if (!isAuthorityCurrent(request)) throw staleAuthorityError();
    const key = chatQueryKeys.sessions(scope);
    await Promise.all([
      queryClient.cancelQueries({ queryKey: key }),
      queryClient.cancelQueries({ queryKey: chatQueryKeys.session(scope, sessionId) }),
    ]);
    if (!isAuthorityCurrent(request)) throw staleAuthorityError();
    queryClient.setQueryData(key, (items = []) => items.map(item => item.id === sessionId ? { ...item, ...updated } : item));
    queryClient.setQueryData(chatQueryKeys.session(scope, sessionId), (current = {}) => ({ ...current, ...updated }));
    void queryClient.invalidateQueries({ queryKey: key, exact: true });
    return updated;
  }, [capture, queryClient, scope]);

  const refetchSessions = query.refetch;
  const reload = useCallback(async () => {
    if (!isAuthorityCurrent(capture)) throw staleAuthorityError();
    const result = await refetchSessions();
    if (!isAuthorityCurrent(capture)) throw staleAuthorityError();
    return result;
  }, [capture, refetchSessions]);

  return {
    sessions,
    selectedSessionId,
    setSelectedSessionId,
    createSession,
    deleteSession,
    renameSession,
    reload,
    loading: query.isLoading,
    error: query.error,
    hasMoreSessions: Boolean(page?.hasMore),
    totalSessions: page?.total ?? sessions.length,
    loadingMoreSessions: pagination.scope === scope && pagination.loading,
    loadMoreSessionsError: pagination.scope === scope ? pagination.error : "",
    loadMoreSessions,
  };
}

export default useChatSessions;
