import { z } from "zod";
import type { GovernanceRequest } from "./adapter.js";

const policyGateResponseSchema = z.object({
  request_id: z.string().optional(),
  decision: z.string(),
  reason: z.string().optional(),
  conditions: z.array(z.unknown()).optional(),
  citations: z.array(z.string()).optional(),
}).passthrough();

export type PolicyGateOutcome =
  | { outcome: "allow"; reason: string; conditions: string[] }
  | { outcome: "deny"; reason: string }
  | { outcome: "review"; reason: string }
  | { outcome: "fallback"; reason: string };

export type PolicyGateClientConfig = {
  url: string;
  apiKey: string;
  timeoutMs: number;
  fetchImplementation?: typeof fetch;
};

export class PolicyGateClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(config: PolicyGateClientConfig) {
    this.#baseUrl = config.url.trim().replace(/\/+$/, "");
    this.#apiKey = config.apiKey.trim();
    this.#timeoutMs = config.timeoutMs;
    this.#fetch = config.fetchImplementation ?? fetch;
  }

  async evaluate(request: GovernanceRequest, signal?: AbortSignal): Promise<PolicyGateOutcome> {
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/policy/evaluate`, {
        method: "POST",
        headers: {
          "X-API-Key": this.#apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: buildPrompt(request),
          actor: {
            user_id: request.user.id,
            role: request.user.role,
            department: request.user.department ?? "general",
          },
          context: {
            ...request.caseContext,
            request_id: request.requestId,
            proposed_actions: request.proposedActions,
          },
        }),
        signal: combined,
      });
    } catch {
      const reason = timeoutSignal.aborted
        ? "policy gate request timed out"
        : "policy gate is unreachable";
      return { outcome: "fallback", reason };
    }

    if (!response.ok) {
      return { outcome: "fallback", reason: `policy gate returned HTTP ${response.status}` };
    }

    let decoded: unknown;
    try {
      decoded = await response.json();
    } catch {
      return { outcome: "fallback", reason: "policy gate response was not valid JSON" };
    }

    const parsed = policyGateResponseSchema.safeParse(decoded);
    if (!parsed.success) {
      return { outcome: "fallback", reason: "policy gate response did not match expected schema" };
    }

    const { decision, reason = "policy gate decision" } = parsed.data;

    switch (decision) {
      case "allow":
        return { outcome: "allow", reason, conditions: [] };
      case "allow_with_conditions": {
        const conditions = (parsed.data.conditions ?? []).map((c) =>
          typeof c === "string" ? c : JSON.stringify(c),
        );
        return { outcome: "allow", reason, conditions };
      }
      case "deny":
        return { outcome: "deny", reason };
      case "review":
        return { outcome: "review", reason };
      default:
        return { outcome: "fallback", reason: `policy gate returned unrecognised decision "${decision}"` };
    }
  }
}

function buildPrompt(request: GovernanceRequest): string {
  const parts: string[] = [
    `User intent: ${request.intent}`,
    `Proposed workflow actions: ${request.proposedActions.join(", ") || "none"}`,
  ];
  if (Object.keys(request.caseContext).length > 0) {
    parts.push(`Context: ${JSON.stringify(request.caseContext)}`);
  }
  return parts.join(". ");
}
