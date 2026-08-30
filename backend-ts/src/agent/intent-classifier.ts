export type Intent = "QUERY" | "AUDIT" | "ACTION" | "CAPABILITIES" | "TOOL_CALL" | "WORKFLOW_MODIFY";

const WORKFLOW_MODIFY_PATTERNS = [
  "modify the workflow", "change the workflow", "update the workflow", "edit the workflow",
  "modify step", "change step", "remove step", "add step",
  "update step", "edit step", "rename step", "reorder step",
  "adjust the workflow", "fix the workflow", "tweak the workflow",
  "modify this workflow", "change this workflow", "update this workflow",
];

const TOOL_CALL_PATTERNS = [
  "approve", "reject", "submit", "create a purchase", "create an invoice",
  "create a vendor", "create a supplier", "create an order", "update the vendor",
  "update the supplier", "delete the", "remove the vendor", "remove the supplier",
  "pay the invoice", "process the payment", "execute the", "run the operation",
  "apply the change", "confirm the", "trigger the", "post the", "close the po",
  "mark as", "set status", "change status", "flag the", "place the order",
  "do it now", "go ahead and", "actually do", "actually execute", "proceed with",
];

const CAPABILITIES_PATTERNS = [
  "what can i do", "what actions", "what can you do", "what can the erp",
  "what features", "what capabilities", "what functions", "what tools",
  "available actions", "available features", "available tools",
  "help me understand", "what is possible", "what can be done",
  "things i can do", "things you can do", "what do you support",
  "capabilities", "what operations", "supported operations",
  "list all tools", "list erp tools", "list the tools", "show all tools",
  "show me all tools", "show me the tools", "show erp tools",
  "all available tools", "what tools are available", "all erp tools",
  "show available tools", "list available tools",
];

// Workflow generation requests — must be checked before QUERY patterns
// because they often contain query-like words ("get", "list", "find")
const WORKFLOW_PATTERNS = [
  "generate workflow", "create workflow", "build workflow", "make workflow",
  "generate a workflow", "create a workflow", "build a workflow", "make a workflow",
  "design workflow", "design a workflow", "write workflow", "write a workflow",
  "workflow to get", "workflow to list", "workflow to fetch", "workflow to retrieve",
  "workflow to send", "workflow to check", "workflow that", "workflow for",
  "send it to canvas", "send to canvas", "pass to canvas", "open in canvas",
  "add to canvas", "show in canvas",
  "automate", "automation for", "automation to",
];

const AUDIT_PATTERNS = [
  "why was", "why is", "why did", "why wasn't", "why can't",
  "what happened", "explain why", "blocked", "rejected", "denied",
  "explain the", "reason for", "audit log", "who blocked",
];

const QUERY_PATTERNS = [
  "show me", "show all", "list all", "list the", "find all", "find the",
  "get me", "get all", "get the", "what is the", "what are the",
  "how many", "count of", "how much", "tell me about", "look up",
  "who is", "who are", "which", "where is", "when was", "when did",
  "check the", "check if", "search for", "query", "report on",
  "give me", "fetch", "retrieve", "display", "view the",
  "balance of", "status of", "history of", "records for",
  "invoices", "orders", "employees", "departments", "vendors",
  "suppliers", "customers", "purchase", "payment", "budget",
];

export function classifyIntent(message: string): Intent {
  const normalized = message.toLowerCase().trim();

  for (const pattern of CAPABILITIES_PATTERNS) {
    if (normalized.includes(pattern)) return "CAPABILITIES";
  }

  for (const pattern of WORKFLOW_MODIFY_PATTERNS) {
    if (normalized.includes(pattern)) return "WORKFLOW_MODIFY";
  }

  // Check workflow generation before QUERY — "workflow to get/list/..." contains query words
  for (const pattern of WORKFLOW_PATTERNS) {
    if (normalized.includes(pattern)) return "ACTION";
  }

  for (const pattern of TOOL_CALL_PATTERNS) {
    if (normalized.includes(pattern)) return "TOOL_CALL";
  }

  for (const pattern of AUDIT_PATTERNS) {
    if (normalized.includes(pattern)) return "AUDIT";
  }

  for (const pattern of QUERY_PATTERNS) {
    if (normalized.includes(pattern)) return "QUERY";
  }

  // Default to QUERY — conversational response; only synthesise when user explicitly asks
  return "QUERY";
}
