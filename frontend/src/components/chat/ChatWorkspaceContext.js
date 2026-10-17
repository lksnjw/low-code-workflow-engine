import { createContext, useContext } from "react";

// Presentation state only; no chat, permission or execution state lives here.
export const ChatWorkspaceContext = createContext(null);
export const useChatWorkspace = () => useContext(ChatWorkspaceContext);
