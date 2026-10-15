import type { QueryMessage, QueryTurnResult, QueryToolCall } from "../analysisprovider/query-types.js";
import { assistantToolCallMessage } from "../analysisprovider/provider-continuation.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { libraryModelInputSchema } from "../documents/library-client.js";
import { hasReservedBridgeRole } from "../tools/erpbridge-contract.js";
import { validateToolInput, validateToolSchemaProfile } from "../tools/tool-input-schema.js";
import { validateToolArguments } from "./workflow-runtime-validator.js";
import { promptData } from "../prompts/contracts.js";

export type ToolProposalCorrection = {
  toolName: string;
  reason: "TOOL_NAME" | "ARGUMENT_SCHEMA" | "SCOPE_CHANGE";
  status: "NOT_DISPATCHED";
  correctionRequested: boolean;
};

/** Interactive proposal correction only. Nothing here dispatches, mutates a
 * contract, changes arguments, approves a write or retries a remote request. */
export class ToolProposalCorrector {
  readonly events: ToolProposalCorrection[] = [];
  private readonly rejected = new Set<string>();
  private corrections = 0;
  private pending: QueryToolCall[] | undefined;
  blocked = false;
  constructor(private readonly offered: readonly ToolDefinition[]) {}

  feedback(turn: QueryTurnResult, allowCorrection = true): QueryMessage[] | undefined {
    if (!this.offered.length || turn.stopReason !== "tool_calls" || !turn.toolCalls.length) return undefined;
    if (this.pending && !sameProposalValues(this.pending, turn.toolCalls, this.offered)) {
      this.blocked = true;
      this.events.push({ toolName: "Tool proposal", reason: "SCOPE_CHANGE", status: "NOT_DISPATCHED", correctionRequested: false });
      return undefined;
    }
    if (turn.toolCalls.length > 16) return undefined;
    const checked = turn.toolCalls.map(call => {
      const matches = this.offered.filter(tool => (tool.mcp_tool_name.trim() || tool.name) === call.name);
      const tool = matches.length === 1 ? matches[0] : undefined;
      // Conflicting contracts and identity/credential overrides fail closed.
      if (matches.length > 1 || tool && (validateToolSchemaProfile(libraryModelInputSchema(tool)).length ||
          Object.hasOwn(call.arguments, "role") && (hasReservedBridgeRole(tool) ||
            !Object.hasOwn((tool.input_schema.properties ?? {}) as object, "role"))) ||
          Object.keys(call.arguments).some(key => /^(?:__proto__|prototype|constructor|access_token|api_key|authorization|bearer_token)$/i.test(key)))
        return { call, fatal: true, issues: [] as string[] };
      const schemaIssues = tool ? validateToolInput(libraryModelInputSchema(tool), call.arguments) : ["Use an exact name from the offered read-only tool list; never invent a tool or switch connections."];
      const runtime = tool ? validateToolArguments(call.name, call.arguments, tool) : undefined;
      const issues = [...schemaIssues, ...(runtime?.invalid ?? []), ...(runtime?.missing.map(key => `Required input is missing: ${key}`) ?? [])];
      return { call, fatal: false, issues, tool };
    });
    if (checked.some(item => item.fatal) || !checked.some(item => item.issues.length)) { this.pending = undefined; return undefined; }
    const fingerprint = JSON.stringify(turn.toolCalls.map(call => ({ name: call.name, arguments: call.arguments })));
    const canCorrect = allowCorrection && this.corrections < 2 && !this.rejected.has(fingerprint);
    for (const item of checked.filter(item => item.issues.length)) this.events.push({
      toolName: item.tool ? (item.tool.mcp_tool_name.trim() || item.tool.name) : "Unrecognized tool",
      reason: item.tool ? "ARGUMENT_SCHEMA" : "TOOL_NAME", status: "NOT_DISPATCHED", correctionRequested: canCorrect,
    });
    if (!canCorrect) return undefined;
    this.corrections++; this.rejected.add(fingerprint);
    this.pending = structuredClone(turn.toolCalls);
    return [assistantToolCallMessage(turn), ...checked.map(item => ({ role: "tool" as const, tool_call_id: item.call.id,
      content: promptData({ source: "tool_proposal_validation", status: "NOT_DISPATCHED",
        issues: item.issues.slice(0, 8).map(issue => issue.slice(0, 240)),
        message: "No call in this proposed batch was dispatched. Correct only the tool name or input shape using the offered contract and the user's supplied or confirmed values. Preserve recipients, identifiers and task scope. Never drop values, guess missing inputs, invent authority or retry an actual ERP failure. A schema array remains an array, including one item; a schema string remains a string. If the required value is ambiguous or missing, ask the user instead of fabricating it." }) }))];
  }
}

/** Shape repair cannot silently lose/reorder values, invent IDs, rename
 * business fields, change a known tool or add reads. */
function sameProposalValues(before: QueryToolCall[], after: QueryToolCall[], tools: readonly ToolDefinition[]): boolean {
  if (before.length !== after.length) return false;
  let remaining = 4096;
  const sameValue = (left: unknown, right: unknown, depth = 0): boolean => {
    if (--remaining < 0 || depth > 16) return false;
    if (left === right) return true;
    const decode = (item: unknown): unknown => {
      if (typeof item === "string" && item.length <= 64_000 && /^[\[{]/.test(item.trim())) {
        try { return JSON.parse(item); } catch { /* retain literal text */ }
      }
      return item;
    };
    const decodedLeft = decode(left), decodedRight = decode(right);
    if (decodedLeft !== left || decodedRight !== right) return sameValue(decodedLeft, decodedRight, depth + 1);
    if (Array.isArray(left) && !Array.isArray(right)) return left.length === 1 && sameValue(left[0], right, depth + 1);
    if (Array.isArray(right) && !Array.isArray(left)) return right.length === 1 && sameValue(left, right[0], depth + 1);
    if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => sameValue(value, right[index], depth + 1));
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    const l = left as Record<string, unknown>, r = right as Record<string, unknown>;
    return Object.keys(l).length === Object.keys(r).length && Object.keys(l).every(key => Object.hasOwn(r, key) && sameValue(l[key], r[key], depth + 1));
  };
  return before.every((old, index) => {
    const next = after[index]!;
    if (tools.some(tool => (tool.mcp_tool_name.trim() || tool.name) === old.name) && old.name !== next.name) return false;
    return sameValue(old.arguments, next.arguments);
  });
}
