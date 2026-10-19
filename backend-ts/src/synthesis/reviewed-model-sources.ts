import { toolRoleAllowed } from "../governance/tool-access.js";
import type { CurrentUser, HandlerServices } from "../http/handlers/common.js";
import { assertActorAuthority } from "../http/handlers/model-selection.js";
import { captureCapabilityAdmissionPin, reviewedCapabilityDataClass } from "../registry/capability-admission.js";
import type { ToolDefinition } from "../registry/schemas.js";
import type { ModelDataClass } from "../providers/egress-policy.js";
import { boundMcpConnection, selectedMcpConnectionId } from "../tools/mcp-dispatch-context.js";

export type ReviewedModelSourceContext = {
  profile: "model-source-hints/v1";
  advisoryOnly: true;
  scope: "primary-connection-only";
  callerInputClass: "restricted";
  sources: Array<{ toolId: string; action: string; connectionId: string; dataClass: ModelDataClass; review: "REVIEWED" | "UNKNOWN" }>;
};

/** Authoritative snapshot -> minimal advisory authoring data, never a pin or
 * dispatch grant. No discovery/network calls, secrets, review notes or results.
 * Publication and execution recapture current authority independently. */
export async function reviewedModelSourceContext(services: HandlerServices, user: CurrentUser, offered: readonly ToolDefinition[]): Promise<ReviewedModelSourceContext> {
  if (offered.length > 2048) throw new Error("Source-hint catalog exceeds supported bounds");
  const connectionId = selectedMcpConnectionId(services);
  return services.repository.readAuthoritative(state => {
    assertActorAuthority(state, user);
    const sources: ReviewedModelSourceContext["sources"] = [];
    for (const tool of offered.filter(value => toolRoleAllowed(value.allowed_roles, user.role))) {
      let dataClass: ModelDataClass = "restricted", review: "REVIEWED" | "UNKNOWN" = "UNKNOWN";
      try {
        const { session } = boundMcpConnection(services, connectionId);
        if (session.requiresReviewedRevision !== true || session.dispatchBoundary !== "sdk-entry/v1" || !session.admissionBinding) throw new Error("No supported reviewed session");
        const pin = captureCapabilityAdmissionPin(state, services.registries, tool, session.admissionBinding, undefined, connectionId);
        dataClass = reviewedCapabilityDataClass(state, pin); review = "REVIEWED";
      } catch { /* Unknown/stale/legacy evidence cannot suggest a lower class. */ }
      sources.push({ toolId: tool.tool_id, action: tool.name, connectionId, dataClass, review });
    }
    return { profile: "model-source-hints/v1", advisoryOnly: true, scope: "primary-connection-only", callerInputClass: "restricted", sources };
  });
}
