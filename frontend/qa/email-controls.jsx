// Local Vite-only acceptance harness. Not a production entry point.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../src/context/AuthContext";
import { registryService } from "../src/services/registry.service";
import { chatErpActionsService } from "../src/services/chat-erp-actions.service";
import EmailPreparationHelp from "../src/components/chat/EmailPreparationHelp";
import ChatErpActionCard from "../src/components/chat/ChatErpActionCard";
import "../src/styles/globals.css";
import "../src/styles/theme.css";
import "../src/styles/typography.css";

// Synthetic copy of the current contract shape. Never invokes remote email.
const tool = { name: "qa-email-send", inputSchema: { properties: { from: { type: "string", description: "Examples: support@scp.nimendra.online, items@scp.nimendra.online and schedule-report@scp.nimendra.online. Other local parts allowed." }, to: { type: "array" }, subject: { type: "string" }, text: { type: "string" } } } };
registryService.liveTools = async args => args.toolName ? { tool: { ...tool, name: args.toolName } } : { connectionId: "isolated", tools: [tool.name, "qa-email-schedule", "qa-email-attachment"].map(name => ({ name, effect: "CHANGE_OR_OTHER" })) };
const action = { profile: "erp-chat-action/v1", id: "qa-email", ownerId: "qa", sessionId: "qa_chat", toolName: tool.name, reviewHash: "a".repeat(64), status: "PENDING", expiresAt: new Date(Date.now() + 3600000).toISOString(), arguments: { from: "support@scp.nimendra.online", to: ["recipient@example.test"], subject: "Order summary", text: "Synthetic order summary for isolated UI checks. No ERP records were read." } };
chatErpActionsService.get = async () => structuredClone(action);
chatErpActionsService.execute = async () => { throw new Error("Sending is disabled in this isolated UI harness."); };
function Harness() {
  const [message, setMessage] = useState("");
  return <main className="mx-auto max-w-3xl space-y-6 bg-white p-6 text-gray-900"><h1 className="text-xl font-semibold">Email controls · isolated UI check</h1><p className="text-sm text-gray-500">Synthetic inputs. No email can be sent from this page.</p><EmailPreparationHelp onContinue={async value => { setMessage(value); return {}; }} /><ChatErpActionCard action={action} /><output aria-label="Prepared clarification" className="block whitespace-pre-wrap text-xs">{message}</output></main>;
}
createRoot(document.getElementById("root")).render(<QueryClientProvider client={new QueryClient()}><AuthProvider><Harness /></AuthProvider></QueryClientProvider>);
