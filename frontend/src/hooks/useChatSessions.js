import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { chatService } from "../services/chat.service";

export function useChatSessions(initialSessionId = "") {
  const queryClient = useQueryClient();
  const [selectedSessionId, setSelectedSessionId] = useState(initialSessionId);
  const query = useQuery({ queryKey: ["chat-sessions"], queryFn: chatService.listSessions });
  const sessions = query.data || [];
  const activeSessionId = initialSessionId || selectedSessionId || sessions[0]?.id || "";

  const createSession = useCallback(async (title) => {
    const created = await chatService.createSession(title);
    queryClient.setQueryData(["chat-sessions"], (items = []) => [created, ...items]);
    setSelectedSessionId(created.id);
    return created;
  }, [queryClient]);

  const deleteSession = useCallback(async (sessionId) => {
    await chatService.deleteSession(sessionId);
    queryClient.setQueryData(["chat-sessions"], (items = []) => items.filter((item) => item.id !== sessionId));
    if (selectedSessionId === sessionId) setSelectedSessionId("");
  }, [queryClient, selectedSessionId]);

  const renameSession = useCallback(async (sessionId, title) => {
    const updated = await chatService.updateSession(sessionId, title);
    queryClient.setQueryData(["chat-sessions"], (items = []) => items.map((item) => item.id === sessionId ? { ...item, ...updated } : item));
    return updated;
  }, [queryClient]);

  return {
    sessions,
    selectedSessionId: activeSessionId,
    setSelectedSessionId,
    createSession,
    deleteSession,
    renameSession,
    reload: query.refetch,
    loading: query.isLoading,
    error: query.error,
  };
}

export default useChatSessions;
