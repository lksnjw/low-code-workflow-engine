import { z } from "zod";

import type { RegistryService } from "../registry/service.js";
import { ruleArraySchema, type RuleDefinition } from "../registry/schemas.js";
import { AsyncMutex } from "../repository/async-mutex.js";
import type { Repository } from "../repository/store.js";
import {
  GovernanceAdapter,
  GovernanceAdapterError,
  type GovernanceFailureKind,
  type GovernancePolicySet,
  type GovernanceRequest,
  type GovernanceSource,
} from "./adapter.js";
import type { LlmPolicyFallback } from "./llm-fallback.js";

const persistedSnapshotSchema = z.object({
  policyVersion: z.string(),
  rules: ruleArraySchema,
  evidenceIds: z.array(z.string()),
  ruleVersion: z.string(),
  source: z.enum(["primary", "secondary"]),
  fetchedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
}).strict();

const persistedGovernanceSchema = z.object({
  lastPrimaryPolicyVersion: z.string().nullable(),
  snapshot: persistedSnapshotSchema.nullable(),
}).strict();

type PersistedSnapshot = z.infer<typeof persistedSnapshotSchema>;
type PersistedGovernance = z.infer<typeof persistedGovernanceSchema>;

export type GovernanceDecisionStatus = "FRESH" | "CACHED_WARNING" | "BLOCKED" | "HUMAN_REVIEW";

export type GovernanceDecision = {
  status: GovernanceDecisionStatus;
  policyVersion: string | null;
  registryHash: string;
  source: GovernanceSource | "cache" | null;
  evidenceIds: string[];
  warning: string | null;
  reason: string | null;
};

export type GovernanceOutcome<T> =
  | { allowed: true; decision: GovernanceDecision; value: T }
  | { allowed: false; decision: GovernanceDecision };

export class GovernanceService {
  readonly #mutex = new AsyncMutex();
  #state: PersistedGovernance = { lastPrimaryPolicyVersion: null, snapshot: null };
  readonly #llmFallback: LlmPolicyFallback | null;

  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a GovernanceService instance with its required state.
   ******************************************************************************/
  constructor(
    readonly primary: GovernanceAdapter | null,
    readonly secondary: GovernanceAdapter | null,
    readonly cacheTTLms: number,
    readonly registries: RegistryService,
    readonly repository: Repository,
    llmFallback: LlmPolicyFallback | null = null,
  ) {
    if (!Number.isInteger(cacheTTLms) || cacheTTLms < 0) throw new Error("governance cache TTL must be a nonnegative integer");
    this.#llmFallback = llmFallback;
  }

  /*******************************************************************************
   * Function: initialize
   *
   * Restores persisted governance state and its registry rule snapshot.
   ******************************************************************************/
  async initialize(): Promise<void> {
    const stored = await this.repository.read((state) => state.governancePolicy);
    const parsed = persistedGovernanceSchema.safeParse(stored);
    if (!parsed.success) return;
    this.#state = structuredClone(parsed.data);
    if (this.#state.snapshot !== null) this.applySnapshot(this.#state.snapshot);
  }

  /*******************************************************************************
   * Function: govern
   *
   * Resolves governance policy and evaluates the request using available
   * sources.
   ******************************************************************************/
  async govern<T>(
    request: GovernanceRequest,
    readOnly: boolean,
    evaluateLocally: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<GovernanceOutcome<T>> {
    return this.#mutex.runExclusive(async () => {
      let primaryFailure: GovernanceAdapterError | null = null;
      if (this.primary !== null) {
        try {
          const policy = await this.primary.fetchPolicy(request, signal);
          await this.acceptPrimary(policy);
          return this.allowed(policy, "FRESH", null, evaluateLocally);
        } catch (error) {
          primaryFailure = normalizeFailure(error);
        }
      } else {
        primaryFailure = new GovernanceAdapterError("primary governance endpoint is not configured", "unreachable");
      }

      let secondaryFailure: GovernanceAdapterError | null = null;
      if (this.secondary !== null) {
        try {
          const policy = await this.secondary.fetchPolicy(request, signal);
          const expected = this.#state.lastPrimaryPolicyVersion;
          if (expected === null || policy.policyVersion !== expected) {
            const reason = expected === null
              ? `secondary policy version ${JSON.stringify(policy.policyVersion)} is unknown because no primary version has been recorded`
              : `secondary policy version ${JSON.stringify(policy.policyVersion)} does not exactly match last primary version ${JSON.stringify(expected)}`;
            return this.blocked(readOnly ? "HUMAN_REVIEW" : "BLOCKED", reason, policy.policyVersion, "secondary", policy.evidenceIds);
          }
          await this.acceptSecondary(policy);
          return this.allowed(policy, "FRESH", null, evaluateLocally);
        } catch (error) {
          secondaryFailure = normalizeFailure(error);
        }
      }

      const failure = preferredFailure(primaryFailure, secondaryFailure);
      if (failure.kind === "parse") return this.blocked("BLOCKED", failure.message);
      const cached = this.#state.snapshot;
      // Use cached snapshot for read-only workflows when it has not expired
      if (cached !== null && Date.now() < cached.expiresAt && readOnly) {
        this.applySnapshot(cached);
        const warning = `${failure.message}; using the unexpired last good governance snapshot for a read-only workflow`;
        const value = await evaluateLocally();
        return {
          allowed: true,
          value,
          decision: this.decision("CACHED_WARNING", cached.policyVersion, "cache", cached.evidenceIds, warning, null),
        };
      }
      // All online sources exhausted — try offline LLM + static-policy fallback
      if (this.#llmFallback !== null) {
        try {
          const fallback = await this.#llmFallback.evaluate(request, readOnly, signal);
          if (fallback.allowed) {
            const value = await evaluateLocally();
            const warning = `${failure.message}; decision made by offline policy fallback (${fallback.source}): ${fallback.reason}`;
            return {
              allowed: true,
              value,
              decision: this.decision("CACHED_WARNING", cached?.policyVersion ?? null, "cache", cached?.evidenceIds ?? [], warning, null),
            };
          }
          return this.blocked("BLOCKED", `${fallback.reason} [offline fallback: ${fallback.source}]`, cached?.policyVersion ?? undefined, cached !== null ? "cache" : undefined, cached?.evidenceIds ?? []);
        } catch {
          // Fallback itself failed — final block
        }
      }
      if (cached === null) return this.blocked("BLOCKED", `${failure.message}; no last good governance snapshot is available and offline fallback failed`);
      if (Date.now() >= cached.expiresAt) return this.blocked("BLOCKED", `${failure.message}; the last good governance snapshot is expired and offline fallback failed`, cached.policyVersion, "cache", cached.evidenceIds);
      return this.blocked("BLOCKED", `${failure.message}; side-effecting workflows require a fresh governance response and offline fallback failed`, cached.policyVersion, "cache", cached.evidenceIds);
    });
  }

  /*******************************************************************************
   * Function: allowed
   *
   * Evaluates locally and returns an allowed outcome with governance metadata.
   ******************************************************************************/
  private async allowed<T>(policy: GovernancePolicySet, status: GovernanceDecisionStatus, warning: string | null, evaluateLocally: () => Promise<T>): Promise<GovernanceOutcome<T>> {
    const value = await evaluateLocally();
    return {
      allowed: true,
      value,
      decision: this.decision(status, policy.policyVersion, policy.source, policy.evidenceIds, warning, null),
    };
  }

  /*******************************************************************************
   * Function: blocked
   *
   * Builds a blocked governance outcome with its reason and policy metadata.
   ******************************************************************************/
  private blocked(status: "BLOCKED" | "HUMAN_REVIEW", reason: string, policyVersion?: string, source?: GovernanceSource | "cache", evidenceIds: string[] = []): GovernanceOutcome<never> {
    return {
      allowed: false,
      decision: this.decision(status, policyVersion ?? this.#state.snapshot?.policyVersion ?? null, source ?? (this.#state.snapshot === null ? null : "cache"), evidenceIds.length === 0 ? this.#state.snapshot?.evidenceIds ?? [] : evidenceIds, null, reason),
    };
  }

  /*******************************************************************************
   * Function: decision
   *
   * Assembles governance status, policy provenance, and registry metadata.
   ******************************************************************************/
  private decision(status: GovernanceDecisionStatus, policyVersion: string | null, source: GovernanceSource | "cache" | null, evidenceIds: string[], warning: string | null, reason: string | null): GovernanceDecision {
    return {
      status,
      policyVersion,
      registryHash: this.registries.hash(),
      source,
      evidenceIds: [...evidenceIds],
      warning,
      reason,
    };
  }

  /*******************************************************************************
   * Function: acceptPrimary
   *
   * Persists and applies a fresh primary governance policy snapshot.
   ******************************************************************************/
  private async acceptPrimary(policy: GovernancePolicySet): Promise<void> {
    const snapshot = persistedSnapshot(policy, this.cacheTTLms);
    const next = { lastPrimaryPolicyVersion: policy.policyVersion, snapshot } satisfies PersistedGovernance;
    await this.persist(next);
    this.#state = next;
    this.applySnapshot(snapshot);
  }

  /*******************************************************************************
   * Function: acceptSecondary
   *
   * Persists and applies a secondary governance policy snapshot.
   ******************************************************************************/
  private async acceptSecondary(policy: GovernancePolicySet): Promise<void> {
    const snapshot = persistedSnapshot(policy, this.cacheTTLms);
    const next = { lastPrimaryPolicyVersion: this.#state.lastPrimaryPolicyVersion, snapshot } satisfies PersistedGovernance;
    await this.persist(next);
    this.#state = next;
    this.applySnapshot(snapshot);
  }

  /*******************************************************************************
   * Function: persist
   *
   * Stores a copy of the governance state in the repository.
   ******************************************************************************/
  private async persist(value: PersistedGovernance): Promise<void> {
    await this.repository.mutate((state) => {
      state.governancePolicy = structuredClone(value);
    });
  }

  /*******************************************************************************
   * Function: applySnapshot
   *
   * Applies the governance snapshot's rules to the runtime registry.
   ******************************************************************************/
  private applySnapshot(snapshot: Pick<PersistedSnapshot, "rules" | "ruleVersion">): void {
    this.registries.replaceRuleSnapshot(snapshot.rules, snapshot.ruleVersion);
  }
}

/*******************************************************************************
 * Function: persistedSnapshot
 *
 * Builds a persisted policy snapshot with its fetch and expiry times.
 ******************************************************************************/
function persistedSnapshot(policy: GovernancePolicySet, cacheTTLms: number): PersistedSnapshot {
  const fetchedAt = Date.now();
  return {
    policyVersion: policy.policyVersion,
    rules: structuredClone(policy.rules) as RuleDefinition[],
    evidenceIds: [...policy.evidenceIds],
    ruleVersion: policy.ruleVersion,
    source: policy.source,
    fetchedAt,
    expiresAt: fetchedAt + cacheTTLms,
  };
}

/*******************************************************************************
 * Function: normalizeFailure
 *
 * Converts an unknown failure into a governance adapter error.
 ******************************************************************************/
function normalizeFailure(error: unknown): GovernanceAdapterError {
  return error instanceof GovernanceAdapterError
    ? error
    : new GovernanceAdapterError(error instanceof Error ? error.message : String(error), "unreachable");
}

/*******************************************************************************
 * Function: preferredFailure
 *
 * Selects a governance failure while prioritizing policy parse errors.
 ******************************************************************************/
function preferredFailure(primary: GovernanceAdapterError, secondary: GovernanceAdapterError | null): GovernanceAdapterError {
  if (secondary?.kind === "parse") return secondary;
  if (primary.kind === "parse") return primary;
  return secondary ?? primary;
}
