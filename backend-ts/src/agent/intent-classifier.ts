export type Intent = "QUERY" | "AUDIT" | "ACTION";

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

  for (const pattern of AUDIT_PATTERNS) {
    if (normalized.includes(pattern)) return "AUDIT";
  }

  for (const pattern of QUERY_PATTERNS) {
    if (normalized.includes(pattern)) return "QUERY";
  }

  // Default to ACTION — the gated synthesis path is the safer choice on ambiguity
  return "ACTION";
}
