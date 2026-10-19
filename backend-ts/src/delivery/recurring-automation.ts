import { allRolesToolAccess, toolRoleAllowed } from "../governance/tool-access.js";
import { stringify } from "yaml";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { deliveryIntent } from "./email-draft.js";
import type { RecipientResolution } from "./recipient-resolution.js";
import { effectiveStepKind } from "../models/schemas.js";
import { deliveryOutputReferences, inspectRecurringAnalysis } from "./recurring-analysis.js";
import { recurringDecisionRequest, recurringDecisionScopes, RECURRING_DECISION_REQUIREMENT } from "./recurring-decision-scopes.js";
import { inspectRecurringJoinProvenance } from "./recurring-join-provenance.js";

export type RecurringRequestedResource = "invoices" | "orders";

export type RecurringDeliveryRequest = {
  profile: "recurring-delivery-request/v1";
  cadence: "daily" | "weekly" | "monthly" | "custom";
  channel: "email" | "unspecified";
  requestedAddresses: string[];
  recipientReference: string | null;
  recipientResolution: RecipientResolution | null;
  reportRequested: boolean;
  requestedResources: RecurringRequestedResource[];
  analysisRequested: boolean;
  decisionRequest?: ReturnType<typeof recurringDecisionRequest>;
  scheduleActive: false;
  requirements: string[];
};

export type RecurringAutomationComposition = {
  profile: "recurring-automation-composition/v1";
  status: "CAPABILITIES_MAPPED" | "PARTIAL";
  mappedSteps: Array<{ stepId: string; capability: "report" | "delivery" | "analysis"; tool: string; resource?: RecurringRequestedResource; sourceStepId?: string }>;
  analysis: { status: "NOT_REQUESTED" | "MAPPED" | "UNRESOLVED" };
  relatedRecords: { status: "MATCHED" | "NOT_REQUESTED" | "UNRESOLVED"; relationName?: string };
  reportWindowBound: boolean;
  recipientBound: boolean;
  deliveryBodyBound: boolean;
  readyForPublication: false;
  scheduleActive: false;
  remainingRequirements: string[];
};

const REPORT_REQUIREMENT = "Add exact reviewed ERP report reads and bind every report to the declared server-owned report window.";
const MESSAGE_CONTENT_REQUIREMENT = "Define the exact message content from reviewed inputs.";
const RELATED_REQUIREMENT = "Bind the related-order report directly to the complete invoice report's reviewed related-key output.";
const DELIVERY_REQUIREMENT = "Add one exact reviewed email delivery capability with an explicit operation and delivery-input contract.";
const ANALYSIS_REQUIREMENT = "Add a supported bounded analysis node or retain analysis as an unresolved requested outcome.";
const DELIVERY_BODY_REQUIREMENT = "Bind the delivery body to a confirmed report output; do not invent report content.";
const TIME_REQUIREMENT = "Confirm the local delivery time and IANA timezone; no timezone is inferred from this device.";
const DELIVERY_PROOF_REQUIREMENT = "Confirm the connector's delivery-status semantics; operation acceptance is not proof that the recipient received the message.";
const ACTIVATE_REQUIREMENT = "Publish the reviewed manual workflow, then activate recurrence through the authoritative scheduler. Each effect still requires fresh independent approval.";
const calendarRequirement = (cadence: RecurringDeliveryRequest["cadence"]): string[] => cadence === "weekly" ?
  ["Confirm the exact local weekday for this weekly schedule; no weekday is inferred from the request."] : cadence === "monthly" ?
  ["Confirm the exact local day from 1 through 28 for this monthly schedule; no day is inferred from the request."] : cadence === "custom" ?
  ["The authoritative scheduler supports daily, weekly and monthly calendars only; retain this custom cadence as unresolved."] : [];

function resourceRequirement(resource: RecurringRequestedResource): string {
  return `Add one exact reviewed ERP report capability whose business resource is ${resource} and bind it to the declared server-owned report window.`;
}

function cadence(text: string): RecurringDeliveryRequest["cadence"] {
  const normalized = text.toLowerCase();
  if (/\bdaily\b|\b(?:every|each)\s+(?:day|morning|evening)\b/.test(normalized)) return "daily";
  if (/\bweekly\b|\b(?:every|each)\s+week\b/.test(normalized)) return "weekly";
  if (/\bmonthly\b|\b(?:every|each)\s+month\b/.test(normalized)) return "monthly";
  return "custom";
}

/** A recurrence phrase is workflow-design intent, never authority for an
 * immediate delivery. This contract preserves exactly what the server can
 * derive without inventing a person, timezone, report window or connector. */
export function recurringDeliveryRequest(text: string, directoryResolution?: RecipientResolution | null): RecurringDeliveryRequest | null {
  const intent = deliveryIntent(text);
  if (!intent?.recurring) return null;
  const normalized = text.toLowerCase();
  const resolvedAddress = directoryResolution?.status === "RESOLVED" ? directoryResolution.email : undefined;
  const requestedAddresses = intent.requestedAddresses.length > 0 ? [...intent.requestedAddresses] : resolvedAddress ? [resolvedAddress] : [];
  const exactRecipient = requestedAddresses.length === 1 ? requestedAddresses[0] : null;
  const requestedResources: RecurringRequestedResource[] = [
    ...(/\binvoices?\b/.test(normalized) ? ["invoices" as const] : []),
    ...(/\borders?\b/.test(normalized) ? ["orders" as const] : []),
  ];
  const requestedCadence = cadence(text);
  const decisionRequest = recurringDecisionRequest(text);
  const requirements = [
    ...(decisionRequest ? [RECURRING_DECISION_REQUIREMENT] : []),
    ...(intent.reportRequested ? requestedResources.length ? requestedResources.map(resourceRequirement) : [REPORT_REQUIREMENT] : [MESSAGE_CONTENT_REQUIREMENT]),
    ...(/\banaly[sz](?:e|es|ed|ing|is)\b/.test(normalized) ? [ANALYSIS_REQUIREMENT] : []),
    DELIVERY_REQUIREMENT,
    ...(exactRecipient ? [`Confirm data-sharing permission for the exact recipient ${exactRecipient}.`] : ["Resolve and confirm exactly one authorized recipient; do not guess a person's address."]),
    TIME_REQUIREMENT,
    DELIVERY_PROOF_REQUIREMENT,
    ...calendarRequirement(requestedCadence),
    ACTIVATE_REQUIREMENT,
  ];
  return { profile: "recurring-delivery-request/v1", cadence: requestedCadence, channel: intent.channel,
    requestedAddresses, recipientReference: intent.recipientReference, recipientResolution: directoryResolution ?? null,
    reportRequested: intent.reportRequested, requestedResources,
    analysisRequested: /\banaly[sz](?:e|es|ed|ing|is)\b/.test(normalized), ...(decisionRequest ? { decisionRequest } : {}), scheduleActive: false, requirements };
}

/** Supplies only server-derived request facts and authoring constraints. The
 * provider still proposes the workflow, while the backend validates the exact
 * result before it can be saved. This object is not execution authority. */
export function recurringAutomationCandidateContext(request: RecurringDeliveryRequest): Record<string, unknown> {
  return {
    profile: "recurring-automation-candidate-context/v1",
    automation_request: automationMetadata(request),
    workflow_report_window_inputs: { start: "reportStartAt", end: "reportEndAt" },
    required_unresolved_requirements: request.requirements,
    constraints: [
      "Keep trigger.type manual and schedule_active false.",
      "Use only offered exact capabilities; do not guess a recipient, report field or delivery result.",
      "Use a report capability only for its reviewed report_coverage_contract.business_resource and map every requested resource exactly once in each delivery's preceding scope.",
      "A report step must bind its reviewed window parameters to input.reportStartAt and input.reportEndAt.",
      "A related report must consume the preceding primary report's exact reviewed key projection.",
      "An email delivery step must use the literal requested address when exactly one address is present and bind its body to confirmed report output.",
      "If analysis was requested, use one supported bounded analysis per requested report resource within each delivery scope after its report reads; bind that delivery to every in-scope analysis result.",
      "The delivery body must explicitly reference every requested report resource, or its mapped analysis result. A single related-order summary does not prove invoice content was included.",
      "For a conditional request preserve the original decision_request and its review requirement. Use only declared boolean references and exact owned Yes/No scopes; missing comparisons remain unresolved, not unconditional delivery.",
      "Every possible continuing path to delivery needs every requested report and corresponding analysis. A declared typed join may export only its selected compatible field; field-level report/analysis provenance is checked across all alternatives. No sibling or direct branch-local escape, invented content or inferred consent.",
      "An explicitly requested final Return may follow required delivery or end an explicit no-delivery path; never put requested work after a Return. A terminated branch cannot merge or deliver later. Preserve original Yes/No meanings; no automatic scheduling, publication, approval or delivery proof.",
    ],
  };
}

/** Returns whether live discovery exposes any exact capability that can
 * materially advance this recurring request. Avoids a model round-trip when
 * only an empty shell can truthfully be produced. */
export function hasRecurringCompositionCapability(request: RecurringDeliveryRequest, tools: readonly ToolDefinition[], userRole: string): boolean {
  return tools.some(tool => grantsRole(tool, userRole) &&
    (request.reportRequested && tool.is_read_only && tool.report_coverage_contract !== undefined &&
      request.requestedResources.includes(tool.report_coverage_contract.business_resource as RecurringRequestedResource) ||
    request.channel === "email" && !tool.is_read_only && tool.operation_contract?.effect_class === "notification" &&
      tool.email_delivery_contract !== undefined && safeNotificationRisk(tool.risk_level)));
}

/** Verifies a recurring candidate against server-derived facts and the exact
 * live contracts used for generation. It never repairs model output. Invalid
 * proposals are rejected so the caller can preserve the safe empty shell. */
export function inspectRecurringAutomationCandidate(rawYAML: string, request: RecurringDeliveryRequest, tools: readonly ToolDefinition[], userRole: string): RecurringAutomationComposition {
  const blueprint = parseWorkflowYAMLStrict(rawYAML);
  const issues: string[] = [];
  const scopes = recurringDecisionScopes(blueprint, tools, userRole, request.decisionRequest !== undefined);
  issues.push(...scopes.issues);
  if (blueprint.trigger.type !== "manual") issues.push("Recurring workflow drafts must retain a manual trigger");
  const metadata = record(blueprint.metadata?.automation_request);
  const expected = automationMetadata(request);
  for (const [key, value] of Object.entries(expected)) if (!sameJSON(metadata?.[key], value)) issues.push(`Automation request field ${key} changed or is missing`);

  const inputSchema = record(blueprint.trigger.config?.inputSchema), properties = record(inputSchema?.properties);
  const required = Array.isArray(inputSchema?.required) ? inputSchema.required : [];
  const windowInputReady = inputSchema?.type === "object" && record(properties?.reportStartAt)?.type === "string" &&
    record(properties?.reportEndAt)?.type === "string" && required.includes("reportStartAt") && required.includes("reportEndAt") && inputSchema?.additionalProperties === false;
  const byAction = new Map<string, ToolDefinition>();
  for (const tool of tools) for (const name of [tool.name, tool.mcp_tool_name]) if (name.trim()) byAction.set(name, tool);
  const mappedSteps: RecurringAutomationComposition["mappedSteps"] = [];
  const reportSteps: Array<{ index: number; id: string; tool: ToolDefinition; parameters: Record<string, unknown>; resource: RecurringRequestedResource }> = [];
  const deliverySteps: Array<{ index: number; id: string; tool: ToolDefinition; parameters: Record<string, unknown> }> = [];
  for (const [index, step] of blueprint.steps.entries()) {
    if (effectiveStepKind(step) === "analysis") continue;
    const action = (step.action ?? "").trim(), tool = byAction.get(action);
    if (!tool) { issues.push(`Step ${step.id} does not use one exact live capability`); continue; }
    if (!grantsRole(tool, userRole)) issues.push(`Step ${step.id} is not granted to the current role`);
    const parameters = record(step.parameters) ?? {};
    let recognized = false;
    if (tool.report_coverage_contract && tool.is_read_only) {
      recognized = true;
      const contract = tool.report_coverage_contract;
      const resource = contract.business_resource as RecurringRequestedResource | undefined;
      if (!resource || !request.requestedResources.includes(resource)) {
        issues.push(`Report step ${step.id} has no exact reviewed requested business resource`);
      } else {
        reportSteps.push({ index, id: step.id, tool, parameters, resource });
        mappedSteps.push({ stepId: step.id, capability: "report", tool: tool.name, resource });
      }
      if (!windowInputReady || parameters[contract.start_parameter] !== "{{input.reportStartAt}}" || parameters[contract.end_parameter] !== "{{input.reportEndAt}}")
        issues.push(`Report step ${step.id} is not bound to the server-owned report window inputs`);
      const pagination = contract.pagination, pageParameter = pagination?.profile === "page-number/v1" ? pagination.page_parameter : pagination?.cursor_parameter;
      if (pageParameter && Object.hasOwn(parameters, pageParameter)) issues.push(`Report step ${step.id} may not override server-owned pagination`);
    }
    if (!tool.is_read_only && tool.operation_contract?.effect_class === "notification" && tool.email_delivery_contract && safeNotificationRisk(tool.risk_level)) {
      recognized = true;
      deliverySteps.push({ index, id: step.id, tool, parameters });
      mappedSteps.push({ stepId: step.id, capability: "delivery", tool: tool.name });
    }
    if (!recognized) issues.push(`Step ${step.id} is not a reviewed report or email-delivery capability`);
  }

  for (const resource of request.requestedResources) {
    if (!scopes.structured && reportSteps.filter(report => report.resource === resource).length > 1)
      issues.push(`Requested business resource ${resource} was mapped more than once`);
  }

  let joined: ReturnType<typeof inspectRecurringJoinProvenance> | undefined;
  if (scopes.hasMerges) try {
    joined = inspectRecurringJoinProvenance(blueprint, reportSteps, deliverySteps, request.requestedResources, request.analysisRequested);
    issues.push(...joined.issues);
  } catch (error) { issues.push("Recurring joined provenance failed: " + (error instanceof Error ? error.message : "unsupported evidence")); }
  const relation = joined?.relatedRecords ?? relatedRecordStatus(request, reportSteps, scopes.predecessors);
  const analysis = joined?.analysis ?? inspectRecurringAnalysis(blueprint, request.analysisRequested, request.requestedResources, reportSteps, tools, userRole, scopes.predecessors);
  issues.push(...analysis.issues);
  for (const mapping of analysis.mappings) mappedSteps.push({ stepId: mapping.id, capability: "analysis", tool: "Bounded analysis", resource: mapping.resource, sourceStepId: mapping.sourceStepId });
  const sourceOrder = new Map(blueprint.steps.map((step, index) => [step.id, index]));
  mappedSteps.sort((left, right) => sourceOrder.get(left.stepId)! - sourceOrder.get(right.stepId)!);
  const exactRecipient = request.requestedAddresses.length === 1 ? request.requestedAddresses[0]! : null;
  let recipientBound = deliverySteps.length > 0, deliveryBodyBound = joined?.deliveryBodyBound ?? deliverySteps.length > 0;
  for (const delivery of deliverySteps) {
    const contract = delivery.tool.email_delivery_contract!;
    const visible = scopes.predecessors.get(delivery.id) ?? new Set<string>(), reports = reportSteps.filter(report => visible.has(report.id));
    if (!joined && (reports.length > 2 || request.requestedResources.some(resource => reports.filter(report => report.resource === resource).length !== 1)))
      issues.push(`Delivery ${delivery.id} requires exactly one preceding in-scope report for each requested resource`);
    if (exactRecipient === null) {
      recipientBound = false;
      if (delivery.parameters[contract.recipient_parameter] !== undefined) issues.push("A delivery recipient was supplied without one exact requested address");
    } else if (delivery.parameters[contract.recipient_parameter] !== exactRecipient) recipientBound = false;
    const sources = reports.map(report => request.analysisRequested ? analysis.mappings.find(value => value.sourceStepId === report.id && visible.has(value.id)) ?? report : report);
    const body = deliveryOutputReferences(delivery.parameters[contract.body_parameter]);
    const exact = body?.every(ref => ref.path[0] === "structuredContent" && sources.some(source => source.id === ref.root && visible.has(source.id)));
    if (!joined && !(exact && sources.length > 0 && sources.every(source => body!.some(ref => ref.root === source.id)))) deliveryBodyBound = false;
    if (!joined && request.analysisRequested && sources.some(source => !analysis.mappings.some(value => value.id === source.id)))
      analysis.bound = false;
  }
  if (!scopes.structured && deliverySteps.length > 1) issues.push("A recurring draft may not silently select multiple delivery effects");
  if (!scopes.structured && reportSteps.length > 2) issues.push("The supported recurring report profile permits at most two reviewed report steps");
  if (deliverySteps.some(delivery => !scopes.structured && reportSteps.some(report => report.index > delivery.index))) issues.push("All reviewed report reads must precede the delivery effect");
  if (deliverySteps.some(delivery => !scopes.structured && analysis.mappings.some(node => node.index > delivery.index))) issues.push("Every bounded analysis must precede the delivery effect");
  if (exactRecipient !== null && deliverySteps.length > 0 && !recipientBound) issues.push("The delivery step did not preserve the exact requested address");
  if (request.reportRequested && deliverySteps.length > 0 && !deliveryBodyBound) issues.push("The delivery body must include every requested report or mapped analysis output");
  if (request.requestedResources.includes("invoices") && request.requestedResources.includes("orders") && relation.status !== "MATCHED" &&
      reportSteps.some(report => report.tool.report_coverage_contract?.requested_key_coverage !== undefined))
    issues.push("Invoice and order reports do not have one exact reviewed relationship binding");

  const deliveryMapped = scopes.structured ? deliverySteps.length > 0 : deliverySteps.length === 1;
  const remainingRequirements = recurringCompositionRequirements(request, reportSteps, deliveryMapped ? 1 : 0, relation.status, recipientBound, deliveryBodyBound, windowInputReady, analysis.bound);
  const unresolved = Array.isArray(blueprint.metadata?.unresolved_requirements) ? blueprint.metadata.unresolved_requirements : [];
  for (const requirement of remainingRequirements) if (!unresolved.includes(requirement)) issues.push(`Required unresolved outcome was omitted: ${requirement}`);
  if (issues.length) throw new Error(`Recurring automation candidate failed its server contract: ${[...new Set(issues)].join("; ")}`);
  const everyResourceMapped = request.requestedResources.length > 0 && request.requestedResources.every(resource => reportSteps.some(report => report.resource === resource));
  const fullyMapped = request.cadence !== "custom" && request.reportRequested && everyResourceMapped && windowInputReady && relation.status !== "UNRESOLVED" &&
    deliveryMapped && exactRecipient !== null && recipientBound && deliveryBodyBound && (!request.analysisRequested || analysis.bound) && (!request.decisionRequest || scopes.structured);
  return { profile: "recurring-automation-composition/v1", status: fullyMapped ? "CAPABILITIES_MAPPED" : "PARTIAL", mappedSteps,
    relatedRecords: relation, analysis: { status: !request.analysisRequested ? "NOT_REQUESTED" : analysis.bound ? "MAPPED" : "UNRESOLVED" }, reportWindowBound: !request.reportRequested || reportSteps.length > 0 && windowInputReady,
    recipientBound, deliveryBodyBound, readyForPublication: false, scheduleActive: false, remainingRequirements };
}

/** Builds an intentionally incomplete, non-executable shell when workflow
 * synthesis is unavailable. It gives the canvas a durable source artifact
 * while preserving every unresolved outcome instead of degrading to a
 * one-off email draft or fabricating tool names. */
export function recurringAutomationShell(text: string, request: RecurringDeliveryRequest): string {
  const label = request.cadence === "custom" ? "Recurring" : `${request.cadence[0]!.toUpperCase()}${request.cadence.slice(1)}`;
  return stringify({
    name: `${label} delivery automation`,
    description: `Incomplete workflow request preserved from chat: ${text.slice(0, 500)}`,
    trigger: { type: "manual" },
    steps: [],
    metadata: {
      automation_request: automationMetadata(request),
      unresolved_requirements: request.requirements,
    },
  }).trim();
}

function automationMetadata(request: RecurringDeliveryRequest): Record<string, unknown> {
  return { profile: request.profile, cadence: request.cadence, channel: request.channel, requested_addresses: request.requestedAddresses,
    recipient_reference: request.recipientReference, recipient_resolution: request.recipientResolution,
    report_requested: request.reportRequested, requested_resources: request.requestedResources, analysis_requested: request.analysisRequested,
    ...(request.decisionRequest ? { decision_request: request.decisionRequest } : {}), schedule_active: false };
}

function recurringCompositionRequirements(request: RecurringDeliveryRequest,
  reports: Array<{ index: number; id: string; tool: ToolDefinition; parameters: Record<string, unknown>; resource: RecurringRequestedResource }>, deliveryCount: number,
  relation: RecurringAutomationComposition["relatedRecords"]["status"], recipientBound: boolean, deliveryBodyBound: boolean, windowInputReady: boolean, analysisBound: boolean): string[] {
  const exactRecipient = request.requestedAddresses.length === 1 ? request.requestedAddresses[0]! : null;
  return [
    ...(request.decisionRequest ? [RECURRING_DECISION_REQUIREMENT] : []),
    ...(!request.reportRequested ? [MESSAGE_CONTENT_REQUIREMENT] : []),
    ...(request.reportRequested && !windowInputReady ? [REPORT_REQUIREMENT] : []),
    ...request.requestedResources.filter(resource => !reports.some(report => report.resource === resource)).map(resourceRequirement),
    ...(request.requestedResources.includes("invoices") && request.requestedResources.includes("orders") && relation !== "MATCHED" ? [RELATED_REQUIREMENT] : []),
    ...(request.analysisRequested && !analysisBound ? [ANALYSIS_REQUIREMENT] : []),
    ...(deliveryCount !== 1 ? [DELIVERY_REQUIREMENT] : []),
    ...(request.reportRequested && deliveryCount === 1 && !deliveryBodyBound ? [DELIVERY_BODY_REQUIREMENT] : []),
    ...(exactRecipient === null ? ["Resolve and confirm exactly one authorized recipient; do not guess a person's address."] :
      recipientBound ? [`Confirm data-sharing permission for the exact recipient ${exactRecipient}.`] : [`Bind the reviewed delivery capability to the exact recipient ${exactRecipient} and confirm data-sharing permission.`]),
    TIME_REQUIREMENT,
    DELIVERY_PROOF_REQUIREMENT,
    ...calendarRequirement(request.cadence),
    ACTIVATE_REQUIREMENT,
  ];
}

function relatedRecordStatus(request: RecurringDeliveryRequest,
  reports: Array<{ index: number; id: string; tool: ToolDefinition; parameters: Record<string, unknown>; resource: RecurringRequestedResource }>,
  predecessors: ReadonlyMap<string, ReadonlySet<string>>): RecurringAutomationComposition["relatedRecords"] {
  if (!(request.requestedResources.includes("invoices") && request.requestedResources.includes("orders"))) return { status: "NOT_REQUESTED" };
  const relatedReports = reports.filter(report => report.resource === "orders"); let relationName: string | undefined;
  if (!relatedReports.length) return { status: "UNRESOLVED" };
  for (const related of relatedReports) {
    const coverage = related.tool.report_coverage_contract?.requested_key_coverage;
    const primary = coverage && reports.find(report => {
      const projection = report.tool.report_coverage_contract?.key_projection;
      return report.resource === "invoices" && projection && predecessors.get(related.id)?.has(report.id) && coverage.relation_name === projection.relation_name &&
        related.parameters[coverage.keys_parameter] === `{{${report.id}.structuredContent.${projection.keys_path.join(".")}}}`;
    });
    if (!primary || !coverage || relationName && relationName !== coverage.relation_name) return { status: "UNRESOLVED" };
    relationName = coverage.relation_name;
  }
  return relationName ? { status: "MATCHED", relationName } : { status: "UNRESOLVED" };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sameJSON(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function grantsRole(tool: ToolDefinition, userRole: string): boolean {
  if (allRolesToolAccess()) return toolRoleAllowed(tool.allowed_roles, userRole);
  const role = userRole.trim().toLowerCase();
  return role.length > 0 && tool.allowed_roles.some(allowed => allowed.trim().toLowerCase() === role);
}

function safeNotificationRisk(risk: string): boolean {
  return ["low", "medium"].includes(risk.trim().toLowerCase());
}
