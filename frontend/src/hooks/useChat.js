import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { chatService } from "../services/chat.service";

/*******************************************************************************
 * Function: useChat
 *
 * Provides chat for the useChat module.
 ******************************************************************************/
export function useChat(sessionId) {
  const queryClient = useQueryClient();
/*******************************************************************************
 * Function: session
 *
 * Performs the session operation on the application for the useChat module.
 ******************************************************************************/
  const session = useQuery({
    queryKey: ["chat-session", sessionId],
    queryFn: () => chatService.getSession(sessionId),
    enabled: Boolean(sessionId),
  });
/*******************************************************************************
 * Function: sendMutation
 *
 * Performs the send Mutation operation on mutation for the useChat module.
 ******************************************************************************/
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

  // Reset send-error when the active session changes so stale errors don't bleed into other sessions.
  const resetRef = useRef(sendMutation.reset);
  resetRef.current = sendMutation.reset;
  useEffect(() => { resetRef.current(); }, [sessionId]);

/*******************************************************************************
 * Function: send
 *
 * Performs the send operation on the application for the useChat module.
 ******************************************************************************/
  const send = useCallback(async (text, overrideSessionId, options = {}) => {
    const target = overrideSessionId || sessionId;
    if (!target || !text.trim()) return null;
    try {
      return await sendMutation.mutateAsync({ target, text: text.trim(), options });
    } catch {
      return null;
    }
  }, [sendMutation, sessionId]);

/*******************************************************************************
 * Function: messages
 *
 * Performs the messages operation on the application for the useChat module.
 ******************************************************************************/
  const messages = useMemo(() => session.data?.messages || [], [session.data?.messages]);
/*******************************************************************************
 * Function: artifact
 *
 * Performs the artifact operation on the application for the useChat module.
 ******************************************************************************/
  const artifact = useMemo(() => [...messages].reverse().find((message) => message.artifacts)?.artifacts || null, [messages]);
  // Only surface session-load errors when no messages exist at all (total failure).
  // A background refetch error while messages are visible should not show the banner.
  const sessionError = messages.length === 0 ? session.error : null;
  const error = sendMutation.error || sessionError;
  return {
    messages,
    artifact,
    loading: sendMutation.isPending,
    error: error?.response?.data?.message || (error ? "Chat could not complete the request. Try again." : ""),
    send,
  };
}

export default useChat;
