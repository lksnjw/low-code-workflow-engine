export type Intent = "QUERY" | "AUDIT" | "ACTION" | "CAPABILITIES";

const CAPABILITIES_PATTERNS = [
  "what can i do", "what actions", "what can you do", "what can the erp",
  "what features", "what capabilities", "what functions", "what tools",
  "available actions", "available features", "available tools",
  "help me understand", "what is possible", "what can be done",
  "things i can do", "things you can do", "what do you support",
  "capabilities", "what operations", "supported operations",
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

  // Check workflow generation before QUERY — "workflow to get/list/..." contains query words
  for (const pattern of WORKFLOW_PATTERNS) {
    if (normalized.includes(pattern)) return "ACTION";
  }

  for (const pattern of AUDIT_PATTERNS) {
    if (normalized.includes(pattern)) return "AUDIT";
  }

  for (const pattern of QUERY_PATTERNS) {
    if (normalized.includes(pattern)) return "QUERY";
  }

  // Default to ACTION — the gated synthesis path is the safer choice on ambiguity
  return "ACTION";
}
