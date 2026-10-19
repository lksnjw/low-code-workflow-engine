import { createHash } from "node:crypto";
import { z } from "zod";
import { erpnextReceiptSchema, isErpnextWriteContract } from "../tools/erpnext-document-write.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { toolSchema, type ToolDefinition } from "./schemas.js";
import type { RegistryService } from "./service.js";
import type { Repository, RepositoryState } from "../repository/store.js";
import type { ErpbridgeMcpSession } from "../tools/erpbridge-mcp-client.js";
import { exactBridgeName, matchesBridgeContract } from "../tools/erpbridge-contract.js";
import { assertActorAuthority } from "../http/handlers/model-selection.js";
import { appendAudit, HandlerFailure, nextID, now, type CurrentUser } from "../http/handlers/common.js";
import type { FastifyRequest } from "fastify";
import type { AppConfig } from "../config/config.js";
import type { ReadAdmissionPin } from "../workflows/compiled-read.js";
import { validateToolSchemaProfile } from "../tools/tool-input-schema.js";
import { assertOperationReadbackSources } from "../tools/operation-readback-contract.js";
import { assertReportCoverageContract } from "../tools/report-coverage-contract.js";
import { modelDataClasses, type ModelDataClass } from "../providers/egress-policy.js";
import { assertReadErrorContract } from "../tools/read-business-error.js";
import { discoveredCapabilityPreview } from "./discovered-contract.js";

export const DEFAULT_BRIDGE_CONNECTION = "erpbridge-default";
export function requireProductionAdmissionProfile(config: Pick<AppConfig, "mcpMode" | "mcpTransport">) {
  if (config.mcpMode === "remote" && config.mcpTransport === "bridge-v1")
    throw new Error("Legacy remote bridge-v1 has no reviewed capability-admission profile. Use the supported modern ERPBridge MCP transport or implement and qualify an explicit legacy admission adapter; no live fallback is allowed.");
}
const id = z.string().min(1).max(256), hash = z.string().regex(/^sha256:[a-f0-9]{64}$/), binding = z.string().regex(/^[a-f0-9]{64}$/);
export const observationSchema = z.object({ id, capabilityId: id, connectionId: id, connectionBinding: binding, toolId: id,
  contractHash: hash, definition: toolSchema, discoveredAt: z.string().datetime(), registryHash: hash,
  discoveryGeneration: z.number().int().nonnegative(), remoteMatches: z.boolean() }).strict();
const readPolicySchema = z.object({ effectClass: z.literal("read"), riskClass: z.literal("low"), dataClass: z.enum(modelDataClasses), retryPolicy: z.literal("never"), note: z.string().trim().min(1).max(2000) }).strict();
const operationPolicySchema = z.object({ effectClass: z.enum(["write", "notification"]), riskClass: z.enum(["low", "medium"]), dataClass: z.enum(["internal", "confidential"]), retryPolicy: z.literal("never"),
  requireIndependentApproval: z.literal(true), note: z.string().trim().min(1).max(2000) }).strict();
const policySchema = z.union([readPolicySchema, operationPolicySchema]);
const reviewIdentity = { observationId: id, contractHash: hash, decisionKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) };
const reviewSchema = z.union([readPolicySchema.extend(reviewIdentity).strict(), operationPolicySchema.extend(reviewIdentity).strict()]);
export const revisionSchema = z.object({ id, capabilityId: id, connectionId: id, connectionBinding: binding, toolId: id,
  contractHash: hash, definition: toolSchema, observationId: id, reviewedAt: z.string().datetime(), reviewedBy: z.object({ id, role: z.literal("Platform Admin") }).strict(),
  decisionScope: hash, decisionHash: hash, policy: policySchema, definitionSource: z.literal("discovered-contract/v1").optional() }).strict();
export const admissionSchema = z.object({ capabilityId: id, revisionId: id, state: z.enum(["AVAILABLE", "DISABLED", "BLOCKED"]), version: z.number().int().positive(), updatedAt: z.string().datetime(),
  reason: z.enum(["REMOTE_CONTRACT_DRIFT", "LOCAL_CONTRACT_CHANGED", "CONNECTION_CHANGED"]).optional() }).strict();
export const disableAdmissionSchema = z.object({ revisionId: id, baseVersion: z.number().int().positive(), note: z.string().trim().min(1).max(2000) }).strict();
export const reviewAdmissionSchema = reviewSchema;
const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJSONBytes(value)).digest("hex")}`;
export function requireAdmissionStorage(repository: Repository) {
  if (repository.persistence !== null && repository.persistence.readQueueDurability !== "encrypted-single-writer")
    throw new HandlerFailure(503, "Capability admission requires supported single-writer storage; cross-process review/revocation is not qualified on this backend", { code: "CAPABILITY_STORAGE_UNSUPPORTED" });
}
export const capabilityContractHash = (definition: ToolDefinition) => digest(definition);
export const capabilityIdFor = (connectionId: string, toolId: string) => `cap_${createHash("sha256").update(canonicalJSONBytes([connectionId, toolId])).digest("hex")}`;

export function administrator(state: Readonly<RepositoryState>, user: CurrentUser) {
  const permissions = assertActorAuthority(state, user);
  if (user.role !== "Platform Admin" || !permissions.includes("registry:write")) throw new HandlerFailure(403, "Capability review requires current Platform Admin registry authority");
}
export function activeBinding(session: ErpbridgeMcpSession | undefined) {
  if (!session || session.available === false || session.requiresReviewedRevision !== true || !binding.safeParse(session.admissionBinding).success)
    throw new HandlerFailure(503, "A supported connected modern ERPBridge session is required; health or a URL record is not enough", { code: "ADMISSION_CONNECTION_UNAVAILABLE" });
  return session.admissionBinding!;
}
function supportedReadErrorReview(tool: ToolDefinition) {
  try { assertReadErrorContract(tool); }
  catch { throw new HandlerFailure(422, "Business error mappings require an explicit low-risk ERP read without effects", { code: "ADMISSION_REVIEW_UNSUPPORTED" }); }
}
export function supportedRead(tool: ToolDefinition) {
  if (["digest-pinned-operation-alias", "digest-pinned-mcp-operation-alias"].includes(tool.bridge_contract?.selector ?? "") || tool.operation_contract?.receipt_profile)
    throw new HandlerFailure(422, "An ERPNext operation profile cannot be admitted as a read", { code: "ADMISSION_REVIEW_UNSUPPORTED" });
  supportedReadErrorReview(tool);
  if (!tool.tool_id.trim() || !tool.name.trim() || !tool.bridge_contract || !tool.allowed_roles.length ||
    !tool.is_read_only || tool.risk_level.toLowerCase() !== "low" || tool.side_effects.length || /^system\..*_test$/i.test(tool.name) || /^system\..*_test$/i.test(tool.mcp_tool_name))
    throw new HandlerFailure(422, "This contract requires unsupported effect/risk review; only explicit low-risk reads without side effects can be admitted yet", { code: "ADMISSION_REVIEW_UNSUPPORTED" });
  if (tool.report_coverage_contract) {
    try { assertReportCoverageContract(tool); }
    catch { throw new HandlerFailure(422, "Report coverage requires explicit supported window inputs and complete-result output evidence", { code: "ADMISSION_REVIEW_UNSUPPORTED" }); }
  }
}
export function supportedOperation(tool: ToolDefinition): void {
  if (tool.bridge_contract?.selector === "digest-pinned-alias")
    throw new HandlerFailure(422, "Digest-pinned serving aliases support reviewed read-only tools, not ERP writes", { code: "ADMISSION_REVIEW_UNSUPPORTED" });
  if (tool.operation_contract?.receipt_profile && tool.bridge_contract?.selector !== "digest-pinned-operation-alias")
    throw new HandlerFailure(422, "The ERPNext receipt profile requires its exact operation-alias selector", { code: "ADMISSION_REVIEW_UNSUPPORTED" });
  if (tool.bridge_contract?.selector === "digest-pinned-operation-alias" && (!isErpnextWriteContract(tool) || tool.is_read_only || tool.risk_level.toLowerCase() !== "medium"))
    throw new HandlerFailure(422, "ERPNext operation aliases require the exact reviewed receipt profile and medium-risk independent approval", { code: "ADMISSION_REVIEW_UNSUPPORTED" });
  supportedReadErrorReview(tool);
  const contract = tool.operation_contract, output = tool.bridge_contract?.output_schema;
  if (!tool.tool_id.trim() || !tool.name.trim() || !tool.bridge_contract || !tool.allowed_roles.length || tool.is_read_only || !tool.side_effects.length ||
      !["low", "medium"].includes(tool.risk_level.toLowerCase()) || !contract ||
      (contract.confirmation.source !== "mcp-envelope" && (!output || output.type !== "object")) ||
      validateToolSchemaProfile(tool.input_schema).length || (output && validateToolSchemaProfile(output).length) || /^system\..*_test$/i.test(tool.name))
    throw new HandlerFailure(422, "Operations require an explicit reviewed effect/result contract, supported schemas and low/medium risk; retry is never", { code: "ADMISSION_REVIEW_UNSUPPORTED" });
  if (contract.confirmation.source === "mcp-envelope") {
    if (tool.bridge_contract.selector !== "digest-pinned-mcp-operation-alias" || contract.receipt_profile || contract.readback ||
        canonicalJSONBytes(contract.confirmation).toString() !== canonicalJSONBytes({ source: "mcp-envelope", path: ["acknowledged"], expected: true, meaning: "operation-accepted" }).toString())
      throw new HandlerFailure(422, "Generic MCP operations require exact acknowledged-return evidence, independent approval and no replay", { code: "ADMISSION_REVIEW_UNSUPPORTED" });
    return;
  }
  if (tool.bridge_contract.selector === "digest-pinned-mcp-operation-alias") throw new HandlerFailure(422, "Generic MCP operations cannot claim business confirmation", { code: "ADMISSION_REVIEW_UNSUPPORTED" });
  let schema: unknown = erpnextReceiptSchema(tool) ?? output;
  for (const part of contract.confirmation.path) schema = (schema as { properties?: Record<string, unknown> } | undefined)?.properties?.[part];
  const expectedType = typeof contract.confirmation.expected;
  if (!schema || ![expectedType, expectedType === "number" ? "integer" : expectedType].includes(String((schema as { type?: unknown }).type)))
    throw new HandlerFailure(422, "Operation confirmation must select a declared scalar output field", { code: "ADMISSION_REVIEW_UNSUPPORTED" });
  if (contract.readback) {
    try { assertOperationReadbackSources(tool); }
    catch { throw new HandlerFailure(422, "Operation read-back selectors require supported declared non-secret business fields", { code: "ADMISSION_REVIEW_UNSUPPORTED" }); }
  }
}
export function publicRevision(raw: unknown) {
  const revision = revisionSchema.parse(raw);
  const { connectionBinding: _binding, decisionScope: _scope, decisionHash: _decision, ...value } = revision;
  return value;
}
function publicObservation(raw: unknown) {
  const { connectionBinding: _binding, ...value } = observationSchema.parse(raw);
  return { ...value, state: value.remoteMatches ? "REVIEW_REQUIRED" : "BLOCKED", reason: value.remoteMatches ? "EXPLICIT_REVIEW_REQUIRED" : "REMOTE_CONTRACT_DRIFT" };
}

/** Observations are persisted separately; discovery never grants authority.
 * Drift may block an existing admission but cannot automatically re-enable it.
 * Network work stays outside repository mutations. Unknown remote tools are
 * reported as unreviewed inventory, never auto-converted into local actions. */
export async function observeCapabilities(input: { repository: Repository; registries: RegistryService; session: ErpbridgeMcpSession | undefined;
  user: CurrentUser; signal?: AbortSignal; request?: FastifyRequest; connectionId?: string }) {
  const { repository, registries, session, user, request } = input;
  await repository.readAuthoritative(state => administrator(state, user));
  const connectionBinding = activeBinding(session), generation = session!.discoveryGeneration ?? 0;
  const connectionId = input.connectionId ?? DEFAULT_BRIDGE_CONNECTION;
  // Unidentified legacy release rows are not reviewable capabilities. Do not
  // fabricate IDs for them or let them block review of real bridge contracts.
  // Connection-owned rows still go through the strict identity checks below,
  // as do duplicate nonblank IDs; neither can be silently ignored or admitted.
  const registryHash = registries.hash(), definitions = registries.snapshot().tools.filter(tool =>
    (!tool.connection_id || tool.connection_id === connectionId) && (tool.connection_id || tool.tool_id.trim()));
  const remote = await session!.listTools(input.signal);
  if (remote.length > 2048 || canonicalJSONBytes(remote).length > 2000000 || remote.some(tool => typeof tool.name !== "string" || !tool.name.trim() || tool.name.length > 256) || new Set(remote.map(tool => tool.name)).size !== remote.length ||
      registryHash !== registries.hash() || generation !== (session!.discoveryGeneration ?? 0) || activeBinding(session) !== connectionBinding)
    throw new HandlerFailure(409, "Discovery changed or is incomplete; no observation was saved");
  const localIds = definitions.map(tool => tool.tool_id);
  if (definitions.length > 2048 || canonicalJSONBytes(definitions).length > 2000000 || definitions.some(tool => canonicalJSONBytes(tool).length > 65536))
    throw new HandlerFailure(413, "Local capability discovery exceeds supported review budgets");
  if (localIds.some(value => !value.trim() || value.length > 256) || new Set(localIds).size !== localIds.length)
    throw new HandlerFailure(422, "Unique nonblank local capability IDs are required before discovery review");
  const knownNames = new Set(definitions.map(exactBridgeName));
  const inventory = remote.filter(tool => !knownNames.has(tool.name)).map(tool => discoveredCapabilityPreview(tool, connectionId));
  let blockedCount = 0;
  const saved = await repository.mutate(state => {
    administrator(state, user);
    if (registryHash !== registries.hash() || generation !== (session!.discoveryGeneration ?? 0) || activeBinding(session) !== connectionBinding)
      throw new HandlerFailure(409, "Discovery binding changed before save");
    if (Object.keys(state.capabilityObservations).length + definitions.length > 10000) throw new HandlerFailure(429, "Capability observation retention limit reached; review retention before refreshing");
    const observations = definitions.map(definition => {
      const observation = { id: nextID(state, "capobs"), capabilityId: capabilityIdFor(connectionId, definition.tool_id), connectionId, connectionBinding,
        toolId: definition.tool_id, contractHash: capabilityContractHash(definition), definition: structuredClone(definition), discoveredAt: now(), registryHash,
        discoveryGeneration: generation, remoteMatches: remote.some(tool => matchesBridgeContract(definition, tool)) };
      state.capabilityObservations[observation.id] = observation;
      const old = state.capabilityAdmissions[observation.capabilityId];
      if (old) {
        const admission = admissionSchema.parse(old), revision = revisionSchema.parse(state.capabilityRevisions[admission.revisionId]);
        const reason = revision.connectionBinding !== connectionBinding ? "CONNECTION_CHANGED" : revision.contractHash !== observation.contractHash ? "LOCAL_CONTRACT_CHANGED" : !observation.remoteMatches ? "REMOTE_CONTRACT_DRIFT" : undefined;
        if (admission.state === "AVAILABLE" && reason) {
          const blocked = { ...admission, state: "BLOCKED", reason, version: admission.version + 1, updatedAt: now() };
          state.capabilityAdmissions[observation.capabilityId] = blocked; blockedCount++;
          appendAudit(state, user, "capability.drift.blocked", "capability", observation.capabilityId, admission, blocked, request);
        }
      }
      return publicObservation(observation);
    });
    for (const raw of Object.values(state.capabilityAdmissions)) {
      const admission = admissionSchema.parse(raw), revision = revisionSchema.parse(state.capabilityRevisions[admission.revisionId]);
      if (admission.state === "AVAILABLE" && revision.connectionId === connectionId && !localIds.includes(revision.toolId)) {
        const blocked = { ...admission, state: "BLOCKED", reason: "LOCAL_CONTRACT_CHANGED", version: admission.version + 1, updatedAt: now() };
        state.capabilityAdmissions[admission.capabilityId] = blocked; blockedCount++;
        appendAudit(state, user, "capability.drift.blocked", "capability", admission.capabilityId, admission, blocked, request);
      }
    }
    appendAudit(state, user, "capability.discovery.observed", "connection", connectionId, null, { observationIds: observations.map(item => item.id), unreviewedCount: inventory.length }, request);
    return observations;
  });
  return { connectionId, observations: saved, unreviewedInventory: inventory, authorityGranted: false, blockedCount };
}

export async function reviewCapability(input: { repository: Repository; registries: RegistryService; session: ErpbridgeMcpSession | undefined;
  user: CurrentUser; capabilityId: string; connectionId?: string; body: unknown; request?: FastifyRequest }) {
  requireAdmissionStorage(input.repository);
  const value = reviewSchema.safeParse(input.body);
  if (!value.success) throw new HandlerFailure(400, "Invalid capability review; provide exact observation/hash, policy, note and stable decision key");
  const data = value.data, selectedConnectionId = input.connectionId ?? DEFAULT_BRIDGE_CONNECTION;
  const decisionScope = digest([input.user.id, input.capabilityId, data.decisionKey]), decisionHash = digest(data);
  return input.repository.mutate(state => {
    administrator(state, input.user);
    const previous = Object.values(state.capabilityRevisions).find(item => item.decisionScope === decisionScope);
    if (previous) {
      const revision = revisionSchema.parse(previous);
      if (revision.connectionId !== selectedConnectionId) throw new HandlerFailure(404, "Capability review not found for this connection");
      if (revision.decisionHash !== decisionHash) throw new HandlerFailure(409, "This decision key was used for different review input");
      return { revision: publicRevision(revision), admission: admissionSchema.parse(state.capabilityAdmissions[revision.capabilityId]), duplicate: true };
    }
    if (!state.capabilityObservations[data.observationId]) throw new HandlerFailure(404, "Capability observation not found");
    const observation = observationSchema.parse(state.capabilityObservations[data.observationId]);
    if (observation.capabilityId !== input.capabilityId || observation.connectionId !== selectedConnectionId || observation.contractHash !== data.contractHash || !observation.remoteMatches ||
      observation.connectionBinding !== activeBinding(input.session) || observation.discoveryGeneration !== (input.session!.discoveryGeneration ?? 0) ||
      Date.now() - Date.parse(observation.discoveredAt) > 600000 || Date.parse(observation.discoveredAt) > Date.now())
      throw new HandlerFailure(409, "Observation is stale, mismatched or drifted; refresh and review before admission");
    const current = input.registries.snapshot().tools.filter(tool => tool.tool_id === observation.toolId);
    if (current.length !== 1 || capabilityContractHash(current[0]!) !== observation.contractHash) throw new HandlerFailure(409, "Local contract changed; refresh discovery and review");
    if (data.effectClass === "read") supportedRead(current[0]!);
    else {
      supportedOperation(current[0]!);
      if (data.effectClass !== current[0]!.operation_contract!.effect_class || data.riskClass !== current[0]!.risk_level.toLowerCase())
        throw new HandlerFailure(422, "Review must match the exact operation effect and risk contract");
    }
    const revision = { id: nextID(state, "caprev"), capabilityId: observation.capabilityId, connectionId: observation.connectionId, connectionBinding: observation.connectionBinding,
      toolId: observation.toolId, contractHash: observation.contractHash, definition: structuredClone(current[0]!), observationId: observation.id,
      reviewedAt: now(), reviewedBy: { id: input.user.id, role: "Platform Admin" as const }, decisionScope, decisionHash,
      policy: policySchema.parse({ effectClass: data.effectClass, riskClass: data.riskClass, dataClass: data.dataClass, retryPolicy: data.retryPolicy, note: data.note,
        ...(data.effectClass === "read" ? {} : { requireIndependentApproval: true }) }),
      ...(current[0]!.connection_id && current[0]!.tool_id.startsWith("DISCOVERED-") ? { definitionSource: "discovered-contract/v1" as const } : {}) };
    const old = state.capabilityAdmissions[revision.capabilityId];
    const admission = { capabilityId: revision.capabilityId, revisionId: revision.id, state: "AVAILABLE", version: old ? admissionSchema.parse(old).version + 1 : 1, updatedAt: now() };
    state.capabilityRevisions[revision.id] = revision; state.capabilityAdmissions[revision.capabilityId] = admission;
    appendAudit(state, input.user, "capability.admitted", "capability", revision.capabilityId, old ?? null, { revisionId: revision.id, contractHash: revision.contractHash, version: admission.version }, input.request);
    return { revision: publicRevision(revision), admission, duplicate: false };
  });
}

export async function disableCapability(input: { repository: Repository; user: CurrentUser; capabilityId: string; connectionId?: string; body: unknown; request?: FastifyRequest }) {
  requireAdmissionStorage(input.repository);
  const parsed = disableAdmissionSchema.safeParse(input.body);
  if (!parsed.success) throw new HandlerFailure(400, "Invalid disable request; provide current revision/version and note");
  return input.repository.mutate(state => {
    administrator(state, input.user);
    if (!state.capabilityAdmissions[input.capabilityId]) throw new HandlerFailure(404, "Capability admission not found");
    const admission = admissionSchema.parse(state.capabilityAdmissions[input.capabilityId]);
    const revision = revisionSchema.parse(state.capabilityRevisions[admission.revisionId]);
    if (revision.connectionId !== (input.connectionId ?? DEFAULT_BRIDGE_CONNECTION)) throw new HandlerFailure(404, "Capability admission not found for this connection");
    if (admission.revisionId !== parsed.data.revisionId) throw new HandlerFailure(409, "Admission revision changed; reload before disabling");
    // An acknowledgement retry of the same immediately preceding transition
    // returns its current disabled state; it never re-enables anything.
    if (admission.state === "DISABLED" && admission.version === parsed.data.baseVersion + 1) return admission;
    if (admission.version !== parsed.data.baseVersion) throw new HandlerFailure(409, "Admission version changed; reload before disabling");
    const updated = { ...admission, state: "DISABLED", version: admission.version + 1, updatedAt: now() };
    state.capabilityAdmissions[input.capabilityId] = updated;
    appendAudit(state, input.user, "capability.disabled", "capability", input.capabilityId, admission, { ...updated, note: parsed.data.note }, input.request);
    return updated;
  });
}

/** Final application admission gate; no remote call, discovery or replay here. */
export function admissionAuthorizer(repository: Repository, registries: RegistryService, connectionId = DEFAULT_BRIDGE_CONNECTION) {
  return async (definition: ToolDefinition, connectionBinding: string, expectedPin?: ReadAdmissionPin): Promise<void> => {
    requireAdmissionStorage(repository);
    return repository.readAuthoritative(state => {
      captureCapabilityAdmissionPin(state, registries, definition, connectionBinding, expectedPin, connectionId);
    });
  };
}

/** Immutable public identifiers only; connection binding remains private.
 * Compile evidence is not authority: the final SDK gate calls this again. */
export function captureReadAdmissionPin(state: Readonly<RepositoryState>, registries: RegistryService, definition: ToolDefinition, connectionBinding: string,
  expectedPin?: ReadAdmissionPin, connectionId = DEFAULT_BRIDGE_CONNECTION): ReadAdmissionPin {
  supportedRead(definition);
  return captureCapabilityAdmissionPin(state, registries, definition, connectionBinding, expectedPin, connectionId);
}
export function captureCapabilityAdmissionPin(state: Readonly<RepositoryState>, registries: RegistryService, definition: ToolDefinition, connectionBinding: string,
  expectedPin?: ReadAdmissionPin, connectionId = DEFAULT_BRIDGE_CONNECTION): ReadAdmissionPin {
  if (definition.connection_id && definition.connection_id !== connectionId) throw new Error("Capability contract belongs to another connection; no ERP dispatch is authorized");
  const capabilityId = capabilityIdFor(connectionId, definition.tool_id), admission = admissionSchema.safeParse(state.capabilityAdmissions[capabilityId]);
  if (!admission.success || admission.data.state !== "AVAILABLE") throw new Error("Capability is unreviewed, disabled or blocked; no ERP dispatch is authorized");
  const revision = revisionSchema.safeParse(state.capabilityRevisions[admission.data.revisionId]), current = registries.snapshot().tools.filter(tool => tool.tool_id === definition.tool_id);
  if (!revision.success || revision.data.capabilityId !== capabilityId || revision.data.connectionId !== connectionId || revision.data.connectionBinding !== connectionBinding ||
      revision.data.contractHash !== capabilityContractHash(revision.data.definition) || revision.data.contractHash !== capabilityContractHash(definition) ||
      current.length !== 1 || capabilityContractHash(current[0]!) !== revision.data.contractHash) throw new Error("Capability review or connection binding changed; no ERP dispatch is authorized");
  if (definition.is_read_only) {
    supportedRead(definition);
    if (revision.data.policy.effectClass !== "read") throw new Error("Capability policy does not authorize this read");
  } else {
    supportedOperation(definition);
    if (revision.data.policy.effectClass !== definition.operation_contract!.effect_class || revision.data.policy.riskClass !== definition.risk_level.toLowerCase() ||
        !("requireIndependentApproval" in revision.data.policy) || !revision.data.policy.requireIndependentApproval) throw new Error("Capability policy does not authorize this operation");
  }
  const pin = { connectionId, capabilityId, revisionId: revision.data.id, admissionVersion: admission.data.version, contractHash: revision.data.contractHash };
  if (expectedPin && !canonicalJSONBytes(pin).equals(canonicalJSONBytes(expectedPin))) throw new Error("Compiled capability admission changed; explicit recompile/publication is required");
  return pin;
}

/** Classification evidence for an already verified compilation pin, not a
 * dispatch grant. Full registry/connection authorization still uses capture. */
export function reviewedCapabilityDataClass(state: Readonly<RepositoryState>, pin: ReadAdmissionPin): ModelDataClass {
  const admission = admissionSchema.parse(state.capabilityAdmissions[pin.capabilityId]);
  const revision = revisionSchema.parse(state.capabilityRevisions[admission.revisionId]);
  if (admission.state !== "AVAILABLE" || admission.capabilityId !== pin.capabilityId || admission.version !== pin.admissionVersion ||
      admission.revisionId !== pin.revisionId || revision.id !== pin.revisionId || revision.capabilityId !== pin.capabilityId ||
      revision.connectionId !== pin.connectionId || revision.contractHash !== pin.contractHash ||
      capabilityContractHash(revision.definition) !== pin.contractHash)
    throw new Error("Reviewed classification no longer matches the exact available capability pin");
  return revision.policy.dataClass;
}

export async function capabilityAdmissionCatalog(repository: Repository, offset = 0, limit = 10,
  context?: { registries: RegistryService; session?: ErpbridgeMcpSession | undefined; connectionId?: string;
    connections?: Array<{ id: string; primary: boolean; dispatchSupported: boolean }> }) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new HandlerFailure(400, "Invalid review catalog page; limit must be 1–10");
  return repository.readAuthoritative(state => {
    const selectedConnectionId = context?.connectionId ?? DEFAULT_BRIDGE_CONNECTION;
    const observations = Object.values(state.capabilityObservations).map(value => observationSchema.parse(value)).filter(value => value.connectionId === selectedConnectionId).reverse();
    const revisions = Object.values(state.capabilityRevisions).map(value => revisionSchema.parse(value)).filter(value => value.connectionId === selectedConnectionId).reverse();
    const admissions = Object.values(state.capabilityAdmissions).map(value => admissionSchema.parse(value)).filter(value => {
      const revision = state.capabilityRevisions[value.revisionId]; return revision !== undefined && revisionSchema.parse(revision).connectionId === selectedConnectionId;
    });
    const persistence = repository.persistence === null ? "memory-only" : repository.persistence.readQueueDurability === "encrypted-single-writer" ? "durable-single-writer" : "unsupported-for-admission";
    const session = context?.session;
    const connection = { id: selectedConnectionId, state: !session ? "NO_SESSION" : session.available === false ? "CLOSED" : session.requiresReviewedRevision !== true || !binding.safeParse(session.admissionBinding).success ? "UNSUPPORTED_PROFILE" : "INITIALIZED_NOT_QUALIFIED",
      discoveryAvailable: Boolean(session && session.available !== false && session.requiresReviewedRevision === true && binding.safeParse(session.admissionBinding).success),
      qualification: "Not a live ERP authorization or tool execution test" };
    const latest = new Map<string, ReturnType<typeof publicObservation>>();
    for (const raw of observations) { const observation = publicObservation(raw); if (!latest.has(observation.capabilityId)) latest.set(observation.capabilityId, observation); }
    const capabilityIds = [...new Set([...latest.keys(), ...admissions.map(raw => admissionSchema.parse(raw).capabilityId)])];
    const capabilities = capabilityIds.slice(offset, offset + limit).map(capabilityId => {
      const observation = latest.get(capabilityId) ?? null;
      const admission = state.capabilityAdmissions[capabilityId] ? admissionSchema.parse(state.capabilityAdmissions[capabilityId]) : null;
      const revision = admission ? publicRevision(state.capabilityRevisions[admission.revisionId]) : null;
      const rawRevision = admission ? revisionSchema.parse(state.capabilityRevisions[admission.revisionId]) : null;
      const current = context?.registries.snapshot().tools.filter(tool => tool.tool_id === (observation?.toolId ?? revision?.toolId));
      const sameLocal = current?.length === 1 && capabilityContractHash(current[0]!) === observation?.contractHash;
      const privateObservation = observation ? observationSchema.parse(state.capabilityObservations[observation.id]) : null;
      const sameConnection = connection.discoveryAvailable && privateObservation?.connectionBinding === session?.admissionBinding;
      const fresh = observation && Date.now() - Date.parse(observation.discoveredAt) <= 600000 && Date.parse(observation.discoveredAt) <= Date.now();
      let reviewReason = !context ? "REVIEW_CONTEXT_UNAVAILABLE" : persistence === "unsupported-for-admission" ? "UNSUPPORTED_STORAGE" : !connection.discoveryAvailable ? "CONNECTION_UNAVAILABLE" : !observation ? "NO_OBSERVATION" : !observation.remoteMatches ? "REMOTE_CONTRACT_DRIFT" : !sameLocal ? "LOCAL_CONTRACT_CHANGED" : !sameConnection ? "CONNECTION_CHANGED" : !fresh || privateObservation?.discoveryGeneration !== (session?.discoveryGeneration ?? 0) ? "OBSERVATION_STALE" : null;
      if (!reviewReason && current?.[0]) { try { current[0].is_read_only ? supportedRead(current[0]) : supportedOperation(current[0]); } catch { reviewReason = "UNSUPPORTED_EFFECT_OR_RISK"; } }
      // Current local/binding drift blocks the display even before a refresh
      // persists the BLOCKED transition. It never grants authority from a GET.
      const currentMatchesRevision = current?.length === 1 && rawRevision && capabilityContractHash(current[0]!) === rawRevision.contractHash && rawRevision.contractHash === capabilityContractHash(rawRevision.definition);
      const effectiveState = admission?.state === "AVAILABLE" && (!context || persistence === "unsupported-for-admission" || !connection.discoveryAvailable || rawRevision?.connectionBinding !== session?.admissionBinding || !currentMatchesRevision) ? "BLOCKED" : admission?.state ?? observation?.state ?? "BLOCKED";
      return { capabilityId, observation, admission, revision, effectiveState, reviewEligible: reviewReason === null, reviewReason };
    });
    return { observations: observations.slice(offset, offset + limit).map(publicObservation), revisions: revisions.slice(offset, offset + limit).map(publicRevision),
      admissions: admissions.slice(offset, offset + limit).map(value => admissionSchema.parse(value)), offset, limit,
      persistence, connection, capabilities, hasMoreCapabilities: capabilityIds.length > offset + limit,
      roleOptions: Object.values(state.roles).map(role => ({ id: role.id, name: role.name })),
      connections: context?.connections ?? [{ id: selectedConnectionId, primary: true, dispatchSupported: true }],
      hasMoreObservations: observations.length > offset + limit, hasMoreRevisions: revisions.length > offset + limit, hasMoreAdmissions: admissions.length > offset + limit };
  });
}
