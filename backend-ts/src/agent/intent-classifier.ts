import { deliveryIntent } from "../delivery/email-draft.js";
export type Intent = "QUERY" | "AUDIT" | "ACTION" | "CAPABILITIES" | "TOOL_CALL" | "WORKFLOW_MODIFY" | "WORKFLOW_CONTROL" | "EMAIL_DELIVERY" | "WORKFLOW_DISCUSSION" | "CONVERSATION";

const WORKFLOW_MODIFY_PATTERNS = [
  "modify the workflow", "change the workflow", "update the workflow", "edit the workflow",
  "modify step", "change step", "remove step", "add step",
  "update step", "edit step", "rename step", "reorder step",
  "adjust the workflow", "fix the workflow", "tweak the workflow",
  "modify this workflow", "change this workflow", "update this workflow",
  "edit this workflow", "edit the above workflow", "change the above workflow", "update the above workflow",
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

const GENERATION_VERB_PATTERN = /\b(generate|create|build|make|design|write|automate)\b/;

/*******************************************************************************
 * Function: levenshtein
 *
 * Calculates the edit distance between two strings.
 ******************************************************************************/
function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]!
        : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[a.length]![b.length]!;
}

// Literal WORKFLOW_PATTERNS matching misses common typos of "workflow" itself
// (e.g. "wrok flow", "worflow") — a real problem for users who type fast.
// Scan every ~8-char window of the whitespace-stripped message for a near
// match (edit distance <= 2) to "workflow" rather than requiring an exact
// substring.
/*******************************************************************************
 * Function: mentionsWorkflowFuzzy
 *
 * Detects approximate mentions of workflow despite spelling variations.
 ******************************************************************************/
function mentionsWorkflowFuzzy(normalized: string): boolean {
  const stripped = normalized.replace(/[^a-z]/g, "");
  const target = "workflow";
  for (let i = 0; i <= stripped.length - 6; i++) {
    for (let len = 7; len <= 9; len++) {
      const window = stripped.slice(i, i + len);
      if (window.length < 6) continue;
      if (levenshtein(window, target) <= 2) return true;
    }
  }
  return false;
}

/*******************************************************************************
 * Function: classifyIntent
 *
 * Classifies a chat message using the configured intent patterns.
 ******************************************************************************/
export function classifyIntent(message: string, context: { workflowContext?: boolean; nodeContext?: boolean } = {}): Intent {
  // Negative instructions are constraints, not action authority. Keep a later
  // affirmative sentence/contrast, but do not revive commands in a comma-list
  // such as "do not upload, approve or generate a workflow".
  const affirmative = message.replace(/[’‘]/g, "'").split(/(?:[.!?;\n]+|\b(?:but|however|instead)\b)/i)
    .map(clause => clause.replace(/\b(?:do\s+not|don't|never|must\s+not|should\s+not|shouldn't|does\s+not|without)\b[\s\S]*$/i, ""))
    .join(" ");
  const normalized = affirmative.toLowerCase().trim();

  const discussionQuestion = /^(?:(?:please|can you|could you|would you)\s+)?(?:explain|describe|walk me through|tell me about|what (?:is|does|are|would)|how (?:does|do|is|can|would|to)|why|is (?:this|it)|has (?:this|it))\b/.test(normalized);
  const combinedEffect = /\b(?:then|and|also)\s+(?:(?:please|actually)\s+)?(?:run|execute|send|delete|approve|reject|create|change|update|add|remove|publish|schedule)\b/.test(normalized);
  const conceptual = /^(?:(?:please|can you|could you)\s+)?(?:what (?:is|are) (?:a|an)\b|what does .+ mean\b|explain (?:the )?(?:concept|meaning|difference)\b)/.test(normalized);
  if (conceptual && !combinedEffect) return "CONVERSATION";
  const workflowSubject = mentionsWorkflowFuzzy(normalized);
  const contextualSubject = context.workflowContext && !/\b(?:invoices?|orders?|employees?|customers?|vendors?|suppliers?|payments?|balances?)\b/.test(normalized) &&
    /\b(?:this|it|that|these|those|node|step|nodes|steps|canvas|page size|pagination|schedule)\b/.test(normalized);
  if (!combinedEffect && discussionQuestion && (workflowSubject || contextualSubject)) return "WORKFLOW_DISCUSSION";
  if (/^(?:thanks|thank you|hello|hi|okay|ok)(?:\s+(?:a lot|very much|there))?$/.test(normalized)) return "CONVERSATION";
  // Compatibility mode only selects review controls, never an execution grant.
  if ((workflowSubject || context.workflowContext && /\b(?:this|it|that|these|those)\b/.test(normalized)) && !GENERATION_VERB_PATTERN.test(normalized) &&
      /\b(?:run|execute|publish|schedule|pause|stop (?:the |this )?schedule)\b/.test(normalized) && !discussionQuestion && !combinedEffect) return "WORKFLOW_CONTROL";
  // A catalog/count question is not an edit merely because a canvas node is
  // selected. Route it to authoritative discovery instead of a keyword search.
  const catalogQuestion = /\b(?:how many|number of|count(?: of)?|total(?: number of)?)\s+(?:(?:available|erp|erpbridge|bridge|exposed|connected)\s+)*(?:tools|capabilities|operations)\b/.test(normalized);
  if (!combinedEffect && (catalogQuestion || CAPABILITIES_PATTERNS.some(pattern => normalized.includes(pattern)))) return "CAPABILITIES";
  if (context.nodeContext && !discussionQuestion && !/^(?:tell me (?:a joke|a story)|help me (?:write|draft|plan)|write (?:a poem|a story))\b/.test(normalized)) return "WORKFLOW_MODIFY";

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

  // Typo-tolerant fallback for the same intent — "generate a wrok flow to..."
  // has a generation verb plus a near-miss on "workflow" that the literal
  // patterns above never see as a substring.
  if (GENERATION_VERB_PATTERN.test(normalized) && mentionsWorkflowFuzzy(normalized)) return "ACTION";

  const delivery = deliveryIntent(affirmative);
  // Recurrence describes an automation to design and review. It must never
  // fall into the one-off email-draft path and accidentally lose the cadence.
  if (delivery?.recurring) return "ACTION";
  if (delivery) return "EMAIL_DELIVERY";

  for (const pattern of TOOL_CALL_PATTERNS) {
    if (normalized.includes(pattern)) return "TOOL_CALL";
  }

  const businessScope = /\b(?:erp|erpbridge|database|records?|companies|company|uoms?|units? of measure|invoices?|orders?|employees?|departments?|vendors?|suppliers?|customers?|purchase|payments?|budgets?|balances?|inventory|stock|sales|sick leave|leave requests?|documents?)\b|\b(?:get|list|find|search)_[a-z0-9_]+\b|\b(?:emp|inv|po|cust|so|doc|bill|leave|uom)[-_][a-z0-9_-]+\b/.test(normalized);
  for (const pattern of AUDIT_PATTERNS) {
    if (businessScope && normalized.includes(pattern)) return "AUDIT";
  }

  for (const pattern of QUERY_PATTERNS) {
    if (businessScope && normalized.includes(pattern)) return "QUERY";
  }
  if (businessScope || /\b(?:next page|previous page|more results|next results)\b/.test(normalized)) return "QUERY";
  // Ordinary dialogue is not an ERP lookup. A tool-less response cannot turn
  // model knowledge/history into fresh business evidence or action authority.
  return "CONVERSATION";
}
