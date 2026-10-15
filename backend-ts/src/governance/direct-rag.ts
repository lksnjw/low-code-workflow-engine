import type { AppConfig } from "../config/config.js";
import type { CurrentUser } from "../http/handlers/common.js";
import { boundedJSONRequest } from "../core/bounded-json-request.js";
import { OperationDeadlineExceeded } from "../core/bounded-operation.js";
import { interpretPolicyResponse } from "./rbac.js";
import type { PolicyDecision, PolicyRequest } from "./optional-policy.js";
import { z } from "zod";
import { INTERACTIVE_HANDOFF_MS } from "../core/interactive-handoff.js";

export const DIRECT_RAG_HANDOFF_MS = INTERACTIVE_HANDOFF_MS;
// Exact snapshot reads only. This is an additional policy scope, not a tool
// grant: the read broker still checks the current role, token and reviewed pin.
const ERP_REFERENCE_READS = new Set([
  "list_companies", "list_departments", "list_suppliers", "list_item_groups",
  "list_uoms", "list_items", "list_warehouses", "list_bins",
  "list_sales_orders", "list_sales_invoices", "list_purchase_orders",
  "get_item", "get_item_group", "get_uom",
]);
export function directRagConfigured(config: AppConfig): boolean {
  return Boolean(config.ragPolicyAPIBaseURL && config.ragPolicyAPIKey);
}

/** One decision request. No MCP discovery, retry or model-supplied identity.
 * Authentication/contract failures never authorize a local fallback. */
export async function checkDirectRagPolicy(config: AppConfig, user: Pick<CurrentUser, "id" | "role"> & Partial<Pick<CurrentUser, "roleId">>, input: PolicyRequest): Promise<PolicyDecision> {
  const source = "rag" as const;
  if (!directRagConfigured(config)) return { source, decision: "unavailable", reason: "The backend RAG policy service is not configured." };
  try {
    const preparation = input.action === "chat_request";
    const recordPreparation = input.action === "record_workflow_prepare";
    const documentRead = ["pipeline-library-discover", "pipeline-library-search", "pipeline-library-resolve"].includes(input.action) && input.context?.readOnly === true;
    const customerReferenceRead = ["get_customer", "list_customers", "get_customer_group", "get_territory"].includes(input.action) && input.context?.readOnly === true;
    const erpReferenceRead = ERP_REFERENCE_READS.has(input.action) && input.context?.readOnly === true;
    const path = preparation || recordPreparation || documentRead || customerReferenceRead || erpReferenceRead ? "/api/policy/preflight" : ["create_customer", "create_item", "delete_document", "delete_record"].includes(input.action) ? "/api/policy/records/evaluate" : "/api/policy/evaluate";
    const { response, decoded } = await boundedJSONRequest(fetch, new URL(path, config.ragPolicyAPIBaseURL).href, {
      method: "POST", redirect: "error", ...(input.signal ? { signal: input.signal } : {}),
      headers: { "X-API-Key": config.ragPolicyAPIKey!, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ actor: { user_id: user.id, role: user.role, ...(user.roleId ? { role_id: user.roleId } : {}) }, prompt: input.prompt, context: { ...input.context, action: input.action } }),
    }, DIRECT_RAG_HANDOFF_MS, "Direct RAG policy");
    if (!response.ok) return { source, decision: [429, 502, 503, 504].includes(response.status) ? "unavailable" : "deny",
      reason: [401, 403].includes(response.status) ? "The RAG policy service rejected the backend credential or access. Nothing was approved." : "The RAG policy service could not confirm this request." };
    if (JSON.stringify(decoded).length > 256000) return { source, decision: "deny", reason: "The RAG policy response exceeded its supported size. Nothing was approved." };
    if (preparation || recordPreparation || documentRead || customerReferenceRead || erpReferenceRead) {
      const prepared = z.object({ decision: z.enum(["allow", "deny"]), scope: z.literal(recordPreparation ? "record_workflow_preparation" : documentRead ? "caller_scoped_document_read" : customerReferenceRead ? "caller_scoped_customer_reference_read" : erpReferenceRead ? "caller_scoped_erp_reference_read" : "preparation_only"), execution_authorized: z.literal(false), execution_performed: z.literal(false), reason: z.string().min(1).max(1000) }).safeParse(decoded);
      return prepared.success ? { source, decision: prepared.data.decision, reason: prepared.data.reason }
        : { source, decision: "deny", reason: "RAG did not confirm a preparation-only check. Nothing was approved." };
    }
    const result = interpretPolicyResponse(decoded);
    return { source, decision: result.decision, reason: (result.reason || "The RAG policy service returned an explicit decision.").slice(0, 1000) };
  } catch (error) {
    const network = error instanceof TypeError;
    return { source, decision: !input.signal?.aborted && (error instanceof OperationDeadlineExceeded || network) ? "unavailable" : "deny",
      reason: input.signal?.aborted ? "Policy check cancelled." : error instanceof OperationDeadlineExceeded ? "RAG did not return a decision within ten seconds. Nothing was approved." : "The RAG policy decision could not be confirmed. Nothing was approved." };
  }
}
