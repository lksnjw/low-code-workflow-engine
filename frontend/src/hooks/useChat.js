import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { chatService } from "../services/chat.service";

export function useChat(sessionId) {
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: ["chat-session", sessionId],
    queryFn: () => chatService.getSession(sessionId),
    enabled: Boolean(sessionId),
  });
  const sendMutation = useMutation({
    mutationFn: ({ target, text, options }) => chatService.sendMessage(target, text, options),
    onSuccess: (result, variables) => {
      queryClient.setQueryData(["chat-session", variables.target], (current = {}) => ({
        ...current,
        messages: [...(current.messages || []), result.userMessage, result.assistantMessage].filter(Boolean),
      }));
      queryClient.invalidateQueries({ queryKey: ["chat-sessions"] });
    },
  });

  const send = useCallback(async (text, overrideSessionId, options = {}) => {
    const target = overrideSessionId || sessionId;
    if (!target || !text.trim()) return null;
    try {
      return await sendMutation.mutateAsync({ target, text: text.trim(), options });
    } catch {
      return null;
    }
  }, [sendMutation, sessionId]);

  const messages = useMemo(() => session.data?.messages || [], [session.data?.messages]);
  const artifact = useMemo(() => [...messages].reverse().find((message) => message.artifacts)?.artifacts || null, [messages]);
  const error = sendMutation.error || session.error;
  return {
    messages,
    artifact,
    loading: sendMutation.isPending || session.isLoading,
    error: error?.response?.data?.message || (error ? "Chat could not complete the request. Try again." : ""),
    send,
  };
}

export default useChat;
