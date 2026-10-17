// Opt-in LOCAL UI fixture only. No env file, remote provider, persistence or ERP.
// Run from backend-ts: node --import tsx/esm scripts/workspace-qa-server.mjs
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { loadConfig } from "../src/config/config.ts";
import { buildApp } from "../src/http/app.ts";
import { Repository } from "../src/repository/store.ts";
import { RegistryService } from "../src/registry/service.ts";
import { RegistryValidator } from "../src/validator/registry-validator.ts";
import { Executor } from "../src/runner/executor.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { ProviderRuntime } from "../src/providers/runtime.ts";
import { hashPassword } from "../src/authn/password.ts";
import { newReadProgress, appendExecutionEvent } from "../src/runner/read-checkpoints.ts";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.ts";
import { requestRuntimeApproval, runtimeApprovalPolicyHash, updateRuntimeApprovalPolicy } from "../src/runner/runtime-approvals.ts";
import { compileReadWorkflow, readCompilationReceipt } from "../src/workflows/compiled-read.ts";
import { admissionAuthorizer, observeCapabilities, reviewCapability, capabilityContractHash } from "../src/registry/capability-admission.ts";
import { toolSchema } from "../src/registry/schemas.ts";
import { bridgeTransportSchema, exactBridgeName } from "../src/tools/erpbridge-contract.ts";
import { applyWorkflowCommand, workflowCommandSchema } from "../src/workflows/commands.ts";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../src/core/canonical-json.ts";
import { protectedSimulationSource, protectedSimulationRead } from "../tests/fixtures/protected-simulation.js";
import { WORKSPACE_QUERY_SYSTEM_PROMPT } from "../src/prompts/contracts.ts";
import { SynthesisService } from "../src/synthesis/service.ts";

const fixtureWorker = process.env.WORKSPACE_QA_READ_STATE === "worker";
const collectionCanvas = process.env.WORKSPACE_QA_CANVAS === "collection";
const protectedSimulationCanvas = process.env.WORKSPACE_QA_CANVAS === "protected-simulation";
const protectedCanvas = process.env.WORKSPACE_QA_CANVAS === "protected" || protectedSimulationCanvas;
const approvalFixture = process.env.WORKSPACE_QA_APPROVAL === "1";
const operationFixture = process.env.WORKSPACE_QA_OPERATION === "1";
const unknownOperation = process.env.WORKSPACE_QA_OPERATION_OUTCOME === "unknown";
const readbackFixture = process.env.WORKSPACE_QA_READBACK === "1";
const statusOutcome = process.env.WORKSPACE_QA_STATUS_OUTCOME || "ABSENT";
const queryDelay = Number(process.env.WORKSPACE_QA_QUERY_DELAY_MS || 0);
const modelFallbackFixture = process.env.WORKSPACE_QA_MODEL_FALLBACK === "1";
if (modelFallbackFixture && (!fixtureWorker || collectionCanvas || protectedCanvas || approvalFixture || operationFixture))
  throw new Error("Model-fallback UI QA requires only the isolated synthetic read-worker fixture");
if (readbackFixture && (!unknownOperation || !["APPLIED", "ABSENT", "PENDING"].includes(statusOutcome) || !Number.isSafeInteger(queryDelay) || queryDelay < 0 || queryDelay > 8000)) throw new Error("Status-query QA requires the isolated unknown operation and a bounded synthetic result/delay");
if (unknownOperation && !operationFixture) throw new Error("Unknown-outcome QA requires the isolated normal operation fixture");
if (operationFixture && (approvalFixture || collectionCanvas || fixtureWorker)) throw new Error("Operation QA is an isolated synthetic normal-worker mode; do not combine fixture modes");
if (approvalFixture && (collectionCanvas || fixtureWorker)) throw new Error("Approval QA uses only its isolated memory-only checkpoint, without a worker or collection mode");
if (protectedCanvas && (operationFixture || approvalFixture || fixtureWorker)) throw new Error("Protected canvas QA is draft-only; no execution modes may be combined");
const config = loadConfig({ APP_ENV: "test", JWT_SECRET: "local-workspace-qa-only-not-production-secret", STORAGE_DRIVER: "memory", MCP_MODE: "mock", CORS_ORIGINS: "http://localhost:5173,http://localhost:5191",
  ...(fixtureWorker ? { MCP_TRANSPORT: "erpbridge-mcp", ERPBRIDGE_BASE_URL: "https://fixture.invalid", ERPBRIDGE_MCP_TOKEN: "fixture-only", ERPBRIDGE_ROLE_MAP: '{"Platform Admin":"admin"}' } : {}) });
const repository = new Repository(null);
const createdAt = new Date().toISOString();
let yaml = stringify({ name: "Daily invoice review", description: "LOCAL fixture only — no real ERP data", trigger: { type: "manual" }, steps: [
  { id: "invoices", action: "demo.echo", description: "Read invoice fixture", parameters: { value: collectionCanvas ? "{{each.item}}" : "local invoices" } },
  { id: "summary", action: operationFixture ? "demo.dispatch" : "demo.echo", description: operationFixture ? "Send synthetic report · independent approval required" : "Prepare report fixture",
    parameters: operationFixture ? { recipient: "manager@example.test", subject: "LOCAL invoice report", body: "{{invoices.structuredContent.value}}" } : { value: collectionCanvas ? "local report" : fixtureWorker ? "{{invoices.structuredContent.value}}" : "{{invoices.structuredContent}}" } },
], ...(collectionCanvas ? { metadata: { controlFlow: { schemaVersion: "read-control-flow/v3", root: { kind: "sequence", nodes: [
  { kind: "foreach", id: "each", maxItems: 3, items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: [{ kind: "literal", value: "FIXTURE-001" }, { kind: "literal", value: "FIXTURE-002" }] } },
    body: { kind: "sequence", nodes: [{ kind: "action", nodeId: "invoices" }] }, collect: { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput", nodeId: "each", path: ["item"] } } },
  { kind: "action", nodeId: "summary" },
] } } } } : {}) });
if (protectedCanvas) yaml = applyWorkflowCommand(yaml, workflowCommandSchema.parse({ type: "wrapProtected", nodeIds: ["invoices"], protectedId: "invoiceLookup", onError: { code: "ERP_RESOURCE_NOT_FOUND" },
  output: { schema: { type: "string" }, success: { kind: "literal", value: "Explicit synthetic body result" }, handled: { kind: "ref", source: "nodeOutput", nodeId: "invoiceLookup", path: ["error", "code"] } } }));
if (protectedSimulationCanvas) yaml = stringify(protectedSimulationSource());
const passwordHash = await hashPassword("Local-QA-only-2026!");
await repository.mutate((state) => {
  state.users.qa = { id: "qa", name: "Local QA", email: "qa@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "QA", departmentId: null, createdAt, lastLoginAt: null };
  state.passwordHashes.qa = passwordHash;
  state.workflows.qa_report = { id: "qa_report", name: "Daily invoice review", description: "Local fixture only", owner: { id: "qa", name: "Local QA" }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: protectedSimulationCanvas ? 4 : 2, successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt, updatedAt: createdAt, yaml, archived: false };
  state.versions.qa_report = [{ version: 1, artifactState: "DRAFT", yaml }];
  // Synthetic historical display evidence only, not a dispatched ERP execution.
  if (!collectionCanvas && !operationFixture) {
  state.executions.qa_display_fixture = { id: "qa_display_fixture", workflowId: "qa_report", workflowName: "Daily invoice review", status: "FAILED", startedAt: createdAt, completedAt: createdAt, durationMs: 0, tokens: { input: 0, output: 0, total: 0 }, costUsd: 0, startedBy: { id: "qa", name: "Local QA" }, workflowSnapshot: { version: 1, contentHash: `sha256:${createHash("sha256").update(yaml).digest("hex")}`, registryHash: "synthetic-display-only", yaml, input: {}, executionProfile: "sequential-read-v1" }, agentSummary: "Synthetic display fixture only. No ERP tools were called.", stepOutputs: { invoices: { structuredContent: [{ invoice_id: "FIXTURE-001", customer: "Example Company", total: 12500, currency: "LKR", paid: false }, { invoice_id: "FIXTURE-002", customer: "Demo Customer", total: 3200, currency: "LKR", paid: true }], content: [{ type: "text", text: "Synthetic fixture data — not retrieved from ERP." }] } } };
  state.timelines.qa_display_fixture = [{ nodeId: "invoices", status: "DONE", startedAt: createdAt, completedAt: createdAt }, { nodeId: "summary", status: "FAILED", startedAt: createdAt, completedAt: createdAt }];
  // Optional synthetic read-state UI fixtures. They do not run a worker or SDK;
  // RUNNING intentionally stays pending to check cancellation-request wording.
  if (["running", "recovery"].includes(process.env.WORKSPACE_QA_READ_STATE)) {
    const item = state.executions.qa_display_fixture;
    item.status = process.env.WORKSPACE_QA_READ_STATE === "running" ? "RUNNING" : "RECOVERY_REQUIRED";
    item.readProgress = newReadProgress(repository);
    item.readProgress.nextStepIndex = 1;
    state.executionEvents[item.id] = [];
    state.timelines[item.id][1].status = item.status === "RUNNING" ? "RUNNING" : "UNKNOWN";
    state.timelines[item.id][1].phase = "DISPATCH_INTENT";
    item.readProgress.attempts = { invoices: { id: "fixture-invoices", nodeId: "invoices", stepIndex: 0, status: "DONE", startedAt: createdAt, completedAt: createdAt }, summary: { id: "fixture-summary", nodeId: "summary", stepIndex: 1, status: item.status === "RUNNING" ? "DISPATCH_INTENT" : "UNKNOWN", startedAt: createdAt, dispatchIntentAt: createdAt } };
    if (item.status === "RUNNING") item.completedAt = null;
    else item.failure = { failureCategory: "READ_OUTCOME_UNKNOWN", failedStepId: "summary" };
    appendExecutionEvent(state, item, "run.started", { syntheticFixture: true });
    appendExecutionEvent(state, item, "node.completed", { syntheticFixture: true, outputRef: "invoices" }, "invoices", "fixture-invoices");
    appendExecutionEvent(state, item, item.status === "RUNNING" ? "node.dispatch_intent" : "node.outcome_unknown", { syntheticFixture: true }, "summary", "fixture-summary");
  }
  }
  state.chats.qa_chat = { id: "qa_chat", ownerId: "qa", title: "Local invoice workspace", createdAt, updatedAt: createdAt, messageCount: 2, messages: [
    { id: "qa_request", role: "user", text: "Prepare an invoice review workflow (local fixture).", createdAt },
    { id: "qa_answer", role: "assistant", text: operationFixture ? "LOCAL fixture draft saved. Publish and Run use the normal read/operation worker against in-process synthetic tools. Each notification waits for the independent reviewer; no real email or ERP action is possible." : fixtureWorker ? "Local fixture draft saved. Only an injected synthetic SDK transport is available; no live ERP or provider is connected. Explicit Publish and Run exercise the real local read worker against fixture echoes." : "Local fixture draft saved. ERP connection is intentionally unavailable; no invoices have been retrieved or sent.", createdAt, artifacts: { intent: "WORKFLOW", workflowId: "qa_report", yaml, selected_workflow_yaml: yaml, validation: { passed: true }, validation_passed: true, can_execute: false } },
  ] };
  if (process.env.WORKSPACE_QA_NAVIGATION === "1") {
    // Saved, zero-step and older-page fixtures exercise actual list/readiness
    // HTTP handlers. They do not connect to any model, hosted database or ERP.
    state.workflows.qa_report.chatSessionId = "qa_chat";
    for (let index = 1; index <= 23; index++) {
      const id = `qa_saved_${index}`;
      state.workflows[id] = { ...state.workflows.qa_report, id, name: `Saved report ${String(index).padStart(2, "0")}`, updatedAt: new Date(Date.parse(createdAt) - index * 1000).toISOString() };
    }
    const emptyYaml = stringify({ name: "Customer onboarding — incomplete draft", description: "LOCAL UI fixture: customer creation tools and required registration fields are unresolved. No ERP action has run.", trigger: { type: "manual" }, steps: [], metadata: { unresolved_requirements: ["Choose an available customer creation tool", "Review required registration fields"] } });
    state.workflows.qa_empty = { ...state.workflows.qa_report, id: "qa_empty", name: "Customer onboarding — incomplete draft", yaml: emptyYaml, steps: 0 };
    state.chats.qa_chat.messages.push({ id: "qa_empty_answer", role: "assistant", text: "LOCAL UI fixture: this incomplete workflow was saved as a draft, not published or executed.", createdAt,
      artifacts: { intent: "WORKFLOW", workflowId: "qa_empty", yaml: emptyYaml, selected_workflow_yaml: emptyYaml, validation: { passed: false }, can_execute: false, blocking_errors: ["UNRESOLVED_REQUIREMENTS"] } });
    state.chats.qa_chat.messageCount = state.chats.qa_chat.messages.length;
  }
});
const registries = await RegistryService.load(resolve("tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
if (protectedSimulationCanvas) {
  const original = registries.snapshot();
  registries.snapshot = () => ({ ...original, tools: [protectedSimulationRead], rules: [] });
  registries.findTool = name => [protectedSimulationRead.tool_id, protectedSimulationRead.name, protectedSimulationRead.mcp_tool_name].includes(name) ? protectedSimulationRead : undefined;
  registries.enabledRules = () => [];
  registries.hash = () => resolvedParameterHashBytes(canonicalJSONBytes({ tools: [protectedSimulationRead], rules: [] }));
}
let operationTools;
if (operationFixture) {
  const original = registries.snapshot(), read = toolSchema.parse({ ...original.tools[0], bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [],
    output_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } } });
  const write = toolSchema.parse({ ...read, tool_id: "QA-OPERATION", name: "demo.dispatch", mcp_tool_name: "demo.dispatch", description: "LOCAL synthetic report acceptance; never email delivery", is_read_only: false,
    required_parameters: ["recipient", "subject", "body"], side_effects: ["LOCAL synthetic notification acceptance"], input_schema: { type: "object", properties: { recipient: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["recipient", "subject", "body"], additionalProperties: false },
    operation_contract: { profile: "operation-result/v1", effect_class: "notification", retry_policy: "never", confirmation: { path: ["accepted"], expected: true, meaning: "operation-accepted" } },
    bridge_contract: { ...read.bridge_contract, resource_digest: "b".repeat(64), output_schema: { type: "object", properties: { accepted: { type: "boolean" }, id: { type: "string" } }, required: ["accepted", "id"], additionalProperties: false } } });
  const status = readbackFixture ? toolSchema.parse({ ...read, tool_id: "QA-OPERATION-STATUS", name: "demo.status", mcp_tool_name: "demo.status", description: "LOCAL operation-state condition only; never delivery or send attribution",
    input_schema: { type: "object", properties: { recipient: { type: "string" }, subject: { type: "string" } }, required: ["recipient", "subject"], additionalProperties: false }, required_parameters: ["recipient", "subject"],
    bridge_contract: { ...read.bridge_contract, resource_digest: "c".repeat(64), output_schema: { type: "object", properties: { recipient: { type: "string" }, subject: { type: "string" }, state: { type: "string" }, settled: { type: "boolean" }, observedAt: { type: "string" } }, required: ["recipient", "subject", "state", "settled", "observedAt"], additionalProperties: false } } }) : undefined;
  if (status) write.operation_contract.readback = { profile: "operation-readback-contract/v1", tool_id: status.tool_id, contract_hash: capabilityContractHash(status),
    arguments: [{ parameter: "recipient", source_path: ["recipient"] }, { parameter: "subject", source_path: ["subject"] }], correlation: [{ source_path: ["recipient"], result_path: ["recipient"] }, { source_path: ["subject"], result_path: ["subject"] }],
    outcome: { path: ["state"], applied: "APPLIED", not_applied: "ABSENT" }, settled_path: ["settled"], observed_at_path: ["observedAt"], max_age_seconds: 60, evidence_meaning: "operation-state" };
  operationTools = [read, write, ...(status ? [status] : [])];
  registries.snapshot = () => ({ ...original, tools: operationTools });
  registries.findTool = name => operationTools.find(tool => [tool.tool_id, tool.name, tool.mcp_tool_name].includes(name));
  registries.hash = () => resolvedParameterHashBytes(canonicalJSONBytes({ tools: operationTools, rules: original.rules }));
  const actor = await repository.effectiveUser("qa");
  await repository.mutate(state => {
    state.roles.qa_review_only = { id: "qa_review_only", name: "Review only", description: "LOCAL independent approver", permissions: ["execution:approve"], createdAt };
    state.users.qa_reviewer = { ...state.users.qa, id: "qa_reviewer", name: "Local reviewer", email: "reviewer@example.test", roleId: "qa_review_only" };
    state.passwordHashes.qa_reviewer = passwordHash;
    if (unknownOperation) {
      state.roles.qa_recovery_only = { id: "qa_recovery_only", name: "Recovery only", description: "LOCAL external evidence only", permissions: ["execution:reconcile"], createdAt };
      state.users.qa_operator = { ...state.users.qa, id: "qa_operator", name: "Local recovery operator", email: "operator@example.test", roleId: "qa_recovery_only" };
      state.passwordHashes.qa_operator = passwordHash;
    }
    updateRuntimeApprovalPolicy(state, actor, { profile: "runtime-approval-policy/v1", baseRevision: 0, enabled: true, approverRoleIds: ["qa_review_only"], ttlSeconds: 3600, separationOfDuties: true });
  });
}
if (approvalFixture) {
  const tool = registries.snapshot().tools.find(item => item.name === "demo.echo"), contractHash = capabilityContractHash(tool);
  const approvalYAML = stringify({ name: "LOCAL exact transaction review", trigger: { type: "manual" }, steps: [{ id: "review", action: tool.name, parameters: { value: "Synthetic invoice report for manager@example.test. Not sent." } }] });
  const pin = { connectionId: "erpbridge-default", capabilityId: "qa-capability", revisionId: "qa-revision", admissionVersion: 1, contractHash };
  const plan = compileReadWorkflow(approvalYAML, [tool], "Platform Admin", new Map([[tool.tool_id, pin]])), compilation = readCompilationReceipt(plan, registries.hash(), "PUBLICATION", "reviewed");
  const actor = await repository.effectiveUser("qa");
  await repository.mutate(state => {
    state.users.qa_requester = { ...state.users.qa, id: "qa_requester", name: "Synthetic requester", email: "requester@example.test" };
    state.roles.qa_review_only = { id: "qa_review_only", name: "Review only", description: "LOCAL fixture only", permissions: ["execution:approve"], createdAt };
    state.users.qa_reviewer = { ...state.users.qa, id: "qa_reviewer", name: "Local reviewer", email: "reviewer@example.test", roleId: "qa_review_only" };
    state.passwordHashes.qa_reviewer = passwordHash;
    updateRuntimeApprovalPolicy(state, actor, { profile: "runtime-approval-policy/v1", baseRevision: 0, enabled: true, approverRoleIds: ["role_admin", "qa_review_only"], ttlSeconds: 3600, separationOfDuties: true });
    state.workflows.qa_approval = { ...state.workflows.qa_report, id: "qa_approval", name: "LOCAL exact transaction review", owner: { id: "qa_requester", name: "Synthetic requester" }, yaml: approvalYAML, steps: 1, publishedVersion: 1 };
    state.versions.qa_approval = [{ id: "qa-publication", artifactState: "PUBLISHED", version: 1, yaml: approvalYAML, compiledRead: { plan, receipt: compilation, verifiedRole: "Platform Admin", compiledAt: createdAt } }];
    state.capabilityAdmissions[pin.capabilityId] = { ...pin, state: "AVAILABLE", revisionId: pin.revisionId, version: 1 };
    state.capabilityRevisions[pin.revisionId] = { capabilityId: pin.capabilityId, connectionId: pin.connectionId, connectionBinding: "b".repeat(64), contractHash, definition: structuredClone(tool) };
    state.executions.qa_exact_approval = { id: "qa_exact_approval", workflowId: "qa_approval", workflowName: "LOCAL exact transaction review", startedBy: state.workflows.qa_approval.owner,
      status: "RUNNING", startedAt: createdAt, completedAt: null, durationMs: 0, tokens: { input: 0, output: 0, total: 0 }, costUsd: 0,
      workflowSnapshot: { version: 1, yaml: approvalYAML, contentHash: plan.sourceHash, registryHash: registries.hash(), input: {}, executionProfile: "sequential-read-v1", compilation }, readProgress: newReadProgress(repository) };
    state.executions.qa_exact_approval.readProgress.attempts.review = { id: "qa-review-attempt", nodeId: "review", stepIndex: 0, status: "PREPARING", startedAt: createdAt };
    state.timelines.qa_exact_approval = [{ id: "qa-review-timeline", nodeId: "review", attemptId: "qa-review-attempt", label: "LOCAL exact review", status: "RUNNING", phase: "PREPARING", startedAt: createdAt }];
    if (process.env.WORKSPACE_QA_NAVIGATION === "1") {
      state.chats.qa_chat.messages.push({ id: "qa_checkpoint_answer", role: "assistant", text: "LOCAL review-only fixture. The exact checkpoint can be reviewed in chat or canvas. No ERP worker or delivery service is connected.", createdAt,
        artifacts: { intent: "WORKFLOW", workflowId: "qa_approval", yaml: approvalYAML, validation: { passed: true }, can_execute: false } });
      state.chats.qa_chat.messageCount = state.chats.qa_chat.messages.length;
    }
  });
  await requestRuntimeApproval(repository, "qa_exact_approval", { executionId: "qa_exact_approval", workflowId: "qa_approval", nodeId: "review", invocationId: "qa-review-attempt", operationKey: "qa-operation",
    sourceHash: plan.sourceHash, semanticHash: plan.semanticHash, connectionId: pin.connectionId, connectionBinding: "b".repeat(64), capabilityId: pin.capabilityId, capabilityRevision: pin.revisionId,
    admissionVersion: 1, contractHash, argumentHash: resolvedParameterHashBytes(canonicalJSONBytes({ value: "Synthetic invoice report for manager@example.test. Not sent." })),
    requesterId: "qa_requester", requesterRoleId: "role_admin", workerEpoch: 1, policyHash: await repository.read(state => runtimeApprovalPolicyHash(state)) },
    { value: "Synthetic invoice report for manager@example.test. Not sent." }, "LOCAL fixture: independent exact review. No ERP or email executor is connected.");
}
const validator = new RegistryValidator(registries, repository);
const executor = new Executor(new ToolRegistry(), validator);
let fixtureModelRequests = 0, fixtureSDKReads = 0;
const providerRuntime = new ProviderRuntime(repository, executor, async (_url, init) => {
  const request = JSON.parse(String(init.body));
  if (modelFallbackFixture && request.messages[0]?.content === WORKSPACE_QUERY_SYSTEM_PROMPT) {
    console.log(`LOCAL fallback fixture model request ${++fixtureModelRequests}: ${request.model}`);
    if (request.model === "fixture-only") return new Response("", { status: 503 });
    if (request.model !== "fixture-backup") throw new Error("Unexpected synthetic backup model");
    const read = request.messages.some(message => message.role === "tool");
    const assistant = request.messages.find(message => message.role === "assistant" && message.tool_calls);
    if (read && JSON.stringify(assistant?.reasoning_details) !== JSON.stringify([{ type: "reasoning.encrypted", data: "LOCAL-private-continuation-fixture" }]))
      throw new Error("Synthetic same-model continuation was not preserved");
    return Response.json({ choices: [{ finish_reason: read ? "stop" : "tool_calls", message: read ? {
      content: "LOCAL synthetic invoice read completed. This is not live ERP data.\n\n| Invoice | Total | Currency |\n| --- | ---: | --- |\n| FIXTURE-001 | 12,500 | LKR |\n\nNo email was sent or schedule activated.",
    } : { content: null, reasoning_details: [{ type: "reasoning.encrypted", data: "LOCAL-private-continuation-fixture" }],
      tool_calls: [{ id: "local-fallback-read", type: "function", function: { name: "demo.echo", arguments: JSON.stringify({ value: "LOCAL synthetic invoice FIXTURE-001: LKR 12500" }) } }],
    } }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
  }
  if (modelFallbackFixture && request.messages[0]?.content.includes("WORKFLOW DRAFT SYNTHESIS"))
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: yaml } }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
  const collectionPatch = request.messages[0].content.includes("ONE SELECTED COLLECTION PATCH");
  const protectedPatch = request.messages[0].content.includes("ONE SELECTED PROTECTED GROUP PATCH");
  let patch = collectionPatch ? { maxItems: 2 } : { description: "Invoice step reviewed by local fixture agent" };
  if (protectedPatch) {
    const data = JSON.parse(request.messages[1].content);
    if (!protectedCanvas || data.instruction !== "LOCAL: change selected protected output to reviewed fallback" || data.node.id !== "invoiceLookup" || data.tools.length)
      throw new Error("Only the exact synthetic protected-group request is supported by this local fixture");
    patch = { output: { ...data.node.output, handled: { kind: "literal", value: "Reviewed synthetic fallback — not absence proof" } } };
  }
  return Response.json({ choices: [{ message: { content: JSON.stringify(patch) } }] });
});
providerRuntime.activate({ id: "qa-fixture", name: "Local fixture", type: "openai_compatible", baseURL: "https://fixture.invalid/v1", apiKey: "fixture-no-network", model: "fixture-only",
  ...(modelFallbackFixture ? { fallbackModel: "fixture-backup" } : {}), temperature: 0, timeoutMs: 1000,
  // Explicit synthetic fixture review; production and runtime egress remain denied.
  egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://fixture.invalid", runtimeAnalysisDataClasses: [], runtimeAgentDataClasses: [], interactiveDataClasses: ["restricted"],
    reviewedAt: createdAt, reviewedBy: { id: "qa", name: "Local QA fixture only" } } });
const erpbridgeSession = operationFixture ? await createErpbridgeMcpSession({ baseURL: "https://fixture.invalid", token: "fixture-only", timeoutMs: readbackFixture ? 10000 : 1000, validator, admissionAuthorizer: admissionAuthorizer(repository, registries),
  sdkClient: { metadataComplete: true, connect: async () => {}, close: async () => {}, listTools: async () => operationTools.map(tool => ({ name: exactBridgeName(tool), inputSchema: bridgeTransportSchema(tool), outputSchema: tool.bridge_contract.output_schema,
    _meta: { "toolplane.resourceDigest": tool.bridge_contract.resource_digest, "toolplane.resourceVersion": "1.0.0", "io.erpbridge/allowedRoles": [] } })),
    callTool: async (name, args) => {
      if (name === exactBridgeName(operationTools[0])) return { content: [], structuredContent: { value: "LOCAL invoice fixture: FIXTURE-001 · LKR 12500. Not live ERP data." } };
      if (readbackFixture && name === exactBridgeName(operationTools[2])) { if (queryDelay) await new Promise(resolve => setTimeout(resolve, queryDelay)); return { content: [], structuredContent: { recipient: args.recipient, subject: args.subject, state: statusOutcome, settled: statusOutcome !== "PENDING", observedAt: new Date().toISOString() } }; }
      if (unknownOperation) throw new Error("LOCAL synthetic lost operation response; never a real ERP/email effect");
      return { content: [], structuredContent: { accepted: true, id: "LOCAL-synthetic-acceptance-only" } };
    } } }) : fixtureWorker ? await createErpbridgeMcpSession({ baseURL: "https://fixture.invalid", token: "fixture-only", timeoutMs: 1000, validator,
  sdkClient: { connect: async () => {}, close: async () => {}, listTools: async () => [{ name: "demo.echo", inputSchema: registries.snapshot().tools[0].input_schema }],
    callTool: async (_name, args) => {
      if (modelFallbackFixture) console.log(`LOCAL fallback fixture SDK read ${++fixtureSDKReads}`);
      const delay = Number(process.env.WORKSPACE_QA_READ_DELAY_MS || 30000);
      // The fallback acceptance fixture confirms an immediate synthetic read.
      // Other modes retain their intentional delayed/uncertain-outcome behavior.
      if (!modelFallbackFixture) await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(60000, Math.max(1000, Number.isFinite(delay) ? delay : 30000))));
      return { content: [{ type: "text", text: "Synthetic SDK echo only — not ERP data." }], structuredContent: { value: args.value, synthetic_fixture: true } };
    } } }) : undefined;
if (operationFixture) {
  const user = await repository.effectiveUser("qa"), observed = await observeCapabilities({ repository, registries, session: erpbridgeSession, user });
  for (const observation of observed.observations) await reviewCapability({ repository, registries, session: erpbridgeSession, user, capabilityId: observation.capabilityId,
    body: { observationId: observation.id, contractHash: observation.contractHash, decisionKey: `qa-review-${observation.toolId}`, effectClass: observation.toolId === "QA-OPERATION" ? "notification" : "read",
      riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Explicit LOCAL synthetic contract review", ...(observation.toolId === "QA-OPERATION" ? { requireIndependentApproval: true } : {}) } });
}
const app = await buildApp({ config, repository, registries, validator, executor, providerRuntime,
  ...(modelFallbackFixture ? { synthesis: new SynthesisService(providerRuntime, registries, validator) } : {}),
  ...(erpbridgeSession ? { erpbridgeSession } : {}) });
await app.listen({ host: "127.0.0.1", port: 8081 });
console.log("LOCAL UI fixture at 127.0.0.1:8081; qa@example.test / Local-QA-only-2026!; memory-only; no ERP/provider network.");
let stopping;
const stop = () => stopping ??= (async () => { await app.close(); await erpbridgeSession?.close(); await repository.close(); })();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stop().then(() => { process.exitCode = 0; }).catch(error => { console.error(error.message); process.exitCode = 1; }); });
