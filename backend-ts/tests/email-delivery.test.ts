import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import { CANDIDATE_PROMPT_VERSION, ProviderRuntime } from "../src/providers/runtime.js";
import { RegistryService } from "../src/registry/service.js";
import { Repository } from "../src/repository/store.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { Executor } from "../src/runner/executor.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { classifyIntent } from "../src/agent/intent-classifier.js";
import { createEmailDraft, deliveryIntent, type EmailDraft } from "../src/delivery/email-draft.js";
import { runQueryLoop } from "../src/agent/query-loop.js";
import { toolSchema } from "../src/registry/schemas.js";
import { parse, stringify } from "yaml";
import { recurringAutomationCandidateContext, recurringDeliveryRequest } from "../src/delivery/recurring-automation.js";
import { SynthesisService } from "../src/synthesis/service.js";
import { recurringAnalysisTools, reportAnalysis } from "./fixtures/recurring-analysis-tools.js";
import { bridgeTransportSchema, exactBridgeName } from "../src/tools/erpbridge-contract.js";
import { RECURRING_DECISION_REQUIREMENT } from "../src/delivery/recurring-decision-scopes.js";
import { recurringCrossJoinWorkflow, recurringJoinWorkflow } from "./fixtures/recurring-join-workflow.js";
import { systemInstructionsFor } from "../src/prompts/contracts.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const requestText = "Get invoice details, analyse the report and email it to manager@example.test";
const headersFor = (id: string, secret: string) => ({ authorization: `Bearer ${jwt.sign({}, secret, { algorithm: "HS256", subject: id, expiresIn: 3600 })}` });
async function setup(options: { bridge?: boolean; calls?: boolean; final?: string; finalStop?: string; failure?: boolean; unadmitted?: boolean; providerFailsAfterRead?: boolean;
  automationTools?: boolean; analysisTools?: boolean; candidateYaml?: string } = {}) {
  const config = { ...loadConfig({ APP_ENV: "test", JWT_SECRET: "test-email-draft-secret-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" }), erpbridgeRoleMap: { "Platform Admin": "admin" } };
  const repository = new Repository(null);
  await repository.mutate((state) => { for (const id of ["owner", "other"]) state.users[id] = { id, name: id, email: `${id}@example.test`, roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "U", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() }; });
  const registries = await RegistryService.load(resolve(options.automationTools ? "tests/fixtures/recurring-tools.json" : options.unadmitted ? "tests/fixtures/tools.json" : "tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
  if (options.analysisTools) { const original = registries.snapshot(); vi.spyOn(registries, "snapshot").mockReturnValue({ ...original, tools: recurringAnalysisTools(original.tools) }); }
  const validator = new RegistryValidator(registries, repository);
  const executor = new Executor(new ToolRegistry(), validator);
  const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
    if (options.candidateYaml !== undefined) return Response.json({ choices: [{ message: { content: options.candidateYaml } }], usage: { prompt_tokens: 5, completion_tokens: 7 } });
    const input = JSON.parse(String(init?.body));
    const hasToolResult = input.messages.some((message: { role: string }) => message.role === "tool");
    if (options.providerFailsAfterRead && hasToolResult) throw new Error("private-provider-secret must not leak");
    return Response.json({ choices: [{ finish_reason: options.calls && !hasToolResult ? "tool_calls" : options.finalStop ?? "stop", message: options.calls && !hasToolResult ? {
      content: "", tool_calls: [{ id: "read-1", type: "function", function: { name: "demo.echo", arguments: '{"value":"fixture report"}' } }],
    } : { content: options.final ?? "Synthetic fixture report for review." } }], usage: { prompt_tokens: 5, completion_tokens: 7 } });
  });
  const providerRuntime = new ProviderRuntime(repository, executor, fetchImplementation);
  providerRuntime.activate({ id: "test", name: "Test", type: "openai_compatible", baseURL: "https://provider.example.test/v1", apiKey: "test", model: "test", temperature: 0, timeoutMs: 1000,
    egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://provider.example.test", runtimeAnalysisDataClasses: [], interactiveDataClasses: ["restricted"], reviewedAt: "2026-10-07T00:00:00.000Z", reviewedBy: { id: "owner", name: "owner" } } });
  const callTool = vi.fn(async () => options.failure ? { content: [{ type: "text", text: "denied" }], isError: true } : { content: [], structuredContent: { value: "fixture report" } });
  const erpbridgeSession = options.bridge ? await createErpbridgeMcpSession({ baseURL: "https://bridge.example.test", token: "fixture-only", timeoutMs: 1000, validator,
    sdkClient: { connect: async () => {}, close: async () => {}, listTools: async () => registries.snapshot().tools.map((tool) => ({ name: exactBridgeName(tool), inputSchema: bridgeTransportSchema(tool),
      ...(tool.bridge_contract ? { ...(tool.bridge_contract.output_schema ? { outputSchema: tool.bridge_contract.output_schema } : {}), _meta: { "toolplane.resourceDigest": tool.bridge_contract.resource_digest, "toolplane.resourceVersion": tool.bridge_contract.resource_version, "io.erpbridge/allowedRoles": tool.bridge_contract.remote_roles } } : {}),
    })), callTool } }) : undefined;
  const app = await buildApp({ config, repository, registries, validator, executor, providerRuntime, synthesis: new SynthesisService(providerRuntime, registries, validator),
    ...(erpbridgeSession ? { erpbridgeSession } : {}) }); apps.push(app);
  const headers = headersFor("owner", config.jwtSecret);
  const created = await app.inject({ method: "POST", url: "/api/chat/sessions", headers, payload: {} });
  const sessionId = created.json().data.id;
  const send = (content = requestText, extra = {}, actor = "owner") => app.inject({ method: "POST", url: `/api/chat/sessions/${sessionId}/messages`, headers: headersFor(actor, config.jwtSecret), payload: { content, ...extra } });
  return { app, repository, send, sessionId, headers, fetchImplementation, callTool };
}
function command(draft: EmailDraft, commandId = "edit-command-00000001") { return { draftId: draft.id, baseVersion: draft.version, baseHash: draft.contentHash, commandId, patch: { to: "confirmed@example.test", subject: "Invoice review", body: "Reviewed report draft." } }; }

test.each([
  "Send an email to manager@example.test", requestText, "Please mail this to my manager",
])("direct delivery request remains explicit: %s", (text) => { expect(classifyIntent(text)).toBe("EMAIL_DELIVERY"); });
test.each(["Send invoice details to my manager every day", "Email the weekly report to manager@example.test"])("recurring delivery becomes workflow design, never a one-off send: %s", (text) => { expect(classifyIntent(text)).toBe("ACTION"); });
test.each(["How would you email the manager?", "What happened to the email?", "Do not send email; list invoices", "Check if the email was sent"])("informational or negated request is not delivery authority: %s", (text) => { expect(classifyIntent(text)).not.toBe("EMAIL_DELIVERY"); });
test.each([
  "Query the synthetic Departments using the available reviewed ERPBridge tool. Return the actual Department names and count. Do not create or change ERP records or send email.",
  "List departments; do not create records or send email",
  "List departments and don't change anything or forward the report",
  "Query departments without changing ERP records or sending email",
  "List departments. Never change records or deliver email",
])("coordinated delivery prohibition stays a read query: %s", text => {
  expect(deliveryIntent(text)).toBeNull(); expect(classifyIntent(text)).toBe("QUERY");
});
test.each([
  "Do not change ERP records. Send the report to manager@example.test",
  "Do not change ERP records; email the report to manager@example.test",
  "Do not change ERP records, but send the report to manager@example.test",
])("a separate explicit delivery clause still prepares review only: %s", text => {
  expect(deliveryIntent(text)).toMatchObject({ requestedAddresses: ["manager@example.test"] });
  expect(classifyIntent(text)).toBe("EMAIL_DELIVERY");
});
test("explicit canvas generation stays a workflow proposal, not a delivery attempt", () => { expect(classifyIntent("Create a workflow to get invoices and email the manager daily")).toBe("ACTION"); });
test("person or multiple-address request never guesses or silently picks a recipient", () => {
  for (const text of ["Send an email to my manager", "Email this to a@example.test and b@example.test"]) {
    const intent = deliveryIntent(text)!;
    expect(createEmailDraft("draft", "chat", "owner", text, intent).to).toBe("");
  }
});
test("an assigned active manager resolves server-side without model or SDK identity guessing", async () => {
  const s = await setup();
  await s.repository.mutate((state) => { state.users.owner!.managerId = "other"; state.users.other!.name = "Finance Manager"; state.users.other!.email = "finance.manager@example.test"; });
  const result = await s.send("Please email this to my manager");
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data.assistantMessage.artifacts.emailDraft).toMatchObject({
    to: "finance.manager@example.test", recipientReference: "my manager",
    recipientResolution: { profile: "recipient-directory-resolution/v1", status: "RESOLVED", source: "DIRECT_MANAGER", userId: "other", userName: "Finance Manager" },
    state: "DRAFT_NOT_SENT",
  });
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});
test("offline recurring request saves an incomplete workflow in the canvas without model, SDK dispatch or active schedule", async () => {
  const s = await setup(); const result = await s.send(requestText + " every day");
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data.assistantMessage.artifacts).toMatchObject({ intent: "WORKFLOW", can_execute: false,
    automationRequest: { profile: "recurring-delivery-request/v1", cadence: "daily", channel: "email", requestedAddresses: ["manager@example.test"], reportRequested: true, scheduleActive: false } });
  expect(result.json().data.assistantMessage.artifacts).not.toHaveProperty("emailDraft");
  expect(result.json().data.answer).toContain("no schedule is active");
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
  const workflows = Object.values((await s.repository.snapshot()).workflows); expect(workflows).toHaveLength(1);
  expect(workflows[0]).toMatchObject({ publishedVersion: 0, draftVersion: 1, canRun: false, trigger: { type: "manual" } });
  expect(workflows[0]!.yaml).toContain("unresolved_requirements"); expect((await s.repository.snapshot()).schedules).toEqual({});
  const restored = await s.app.inject({ method: "GET", url: `/api/chat/sessions/${s.sessionId}`, headers: s.headers });
  expect(restored.json().data.messages[1].artifacts.automationRequest.scheduleActive).toBe(false);
});
test("assigned manager resolution is preserved in a recurring workflow draft without activating or sending", async () => {
  const s = await setup();
  await s.repository.mutate((state) => { state.users.owner!.managerId = "other"; state.users.other!.name = "Maya Perera"; state.users.other!.email = "maya@example.test"; });
  const result = await s.send("Get invoice details and email the report to my manager every day");
  expect(result.statusCode, result.body).toBe(200);
  const artifacts = result.json().data.assistantMessage.artifacts;
  expect(artifacts).toMatchObject({ intent: "WORKFLOW", can_execute: false, automationRequest: {
    requestedAddresses: ["maya@example.test"], recipientReference: "my manager",
    recipientResolution: { status: "RESOLVED", source: "DIRECT_MANAGER", userId: "other" }, scheduleActive: false,
  } });
  expect(artifacts.blocking_errors).toContain("Confirm data-sharing permission for the exact recipient maya@example.test.");
  expect(artifacts.blocking_errors).not.toContain("Resolve and confirm exactly one authorized recipient; do not guess a person's address.");
  expect((await s.repository.snapshot()).schedules).toEqual({}); expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});
test("connected recurrence skips model latency when discovery has no reviewed report or delivery contract", async () => {
  const s = await setup({ bridge: true }); const result = await s.send(requestText + " every day");
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data.assistantMessage.artifacts).toMatchObject({ intent: "WORKFLOW", compositionFailure: "NO_REVIEWED_COMPOSITION_CAPABILITY",
    automationRequest: { scheduleActive: false }, can_execute: false });
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
  const state = await s.repository.snapshot(); expect(Object.values(state.workflows)[0]).toMatchObject({ steps: 0, publishedVersion: 0, canRun: false });
  expect(state.schedules).toEqual({}); expect(state.executions).toEqual({});
});
function recurringCandidate(recipient = "manager@example.test", withAnalysis = false) {
  const text = `${withAnalysis ? "Analyse" : "Get"} invoice and order details and email the report to manager@example.test every day`;
  const request = recurringDeliveryRequest(text)!;
  const unresolved = request.requirements.filter(item => !item.startsWith("Add exact reviewed ERP report") &&
    !item.startsWith("Add one exact reviewed ERP report") && !item.startsWith("Add one exact reviewed email") && !(withAnalysis && item.startsWith("Add a supported bounded analysis")));
  const yaml = stringify({
    name: "Daily invoice and order report", description: "Reads complete invoice and related order reports before proposing reviewed email delivery.",
    trigger: { type: "manual", config: { inputSchema: { type: "object", properties: { reportStartAt: { type: "string" }, reportEndAt: { type: "string" } },
      required: ["reportStartAt", "reportEndAt"], additionalProperties: false } } },
    steps: [
      { id: "invoice_report", action: "erp.invoices.report", description: "Read complete invoices", parameters: { startAt: "{{input.reportStartAt}}", endAt: "{{input.reportEndAt}}" } },
      { id: "order_report", action: "erp.orders.report", description: "Read every related order", parameters: { startAt: "{{input.reportStartAt}}", endAt: "{{input.reportEndAt}}", orderIds: "{{invoice_report.structuredContent.orderIds}}" } },
      ...(withAnalysis ? [reportAnalysis("invoice_analysis", "invoice_report"), reportAnalysis("order_analysis", "order_report")] : []),
      { id: "deliver_report", action: "erp.email.deliver", description: "Propose reviewed report delivery", parameters: { recipient, subject: "Daily invoice and order report", body: withAnalysis ? "Invoices: {{invoice_analysis.structuredContent.text}}\nOrders: {{order_analysis.structuredContent.text}}" : "Invoices: {{invoice_report.structuredContent.summary}}\nOrders: {{order_report.structuredContent.summary}}" } },
    ], metadata: { automation_request: recurringAutomationCandidateContext(request).automation_request, unresolved_requirements: unresolved },
  }).trim();
  return { text, yaml, request, unresolved };
}

test("chat saves requested report analyses as an editable five-node draft without reading ERP or sending", async () => {
  const candidate = recurringCandidate("manager@example.test", true);
  const s = await setup({ bridge: true, automationTools: true, analysisTools: true, candidateYaml: candidate.yaml });
  const result = await s.send(candidate.text); expect(result.statusCode, result.body).toBe(200);
  const artifact = result.json().data.assistantMessage.artifacts;
  expect(artifact).toMatchObject({ intent: "WORKFLOW", can_execute: false, automationComposition: {
    status: "CAPABILITIES_MAPPED", analysis: { status: "MAPPED" }, deliveryBodyBound: true, readyForPublication: false, scheduleActive: false,
  } });
  expect(artifact.automationComposition.mappedSteps).toHaveLength(5);
  const state = await s.repository.snapshot();
  expect(Object.values(state.workflows)[0]).toMatchObject({ steps: 5, publishedVersion: 0, canRun: false, yaml: candidate.yaml });
  expect(state.schedules).toEqual({}); expect(state.executions).toEqual({}); expect(s.callTool).not.toHaveBeenCalled(); expect(s.fetchImplementation).toHaveBeenCalledOnce();
  expect(result.json().data.answer).toContain("5 workflow steps were mapped");
});
test("connected recurring request saves exact useful capability steps without running, publishing, scheduling or sending", async () => {
  const candidate = recurringCandidate(), s = await setup({ bridge: true, automationTools: true, candidateYaml: candidate.yaml });
  const result = await s.send(candidate.text); expect(result.statusCode, result.body).toBe(200);
  const artifact = result.json().data.assistantMessage.artifacts;
  expect(artifact).toMatchObject({ intent: "WORKFLOW", can_execute: false,
    automationRequest: { cadence: "daily", requestedResources: ["invoices", "orders"], scheduleActive: false },
    automationComposition: { profile: "recurring-automation-composition/v1", status: "CAPABILITIES_MAPPED", reportWindowBound: true,
      recipientBound: true, deliveryBodyBound: true, readyForPublication: false, scheduleActive: false, remainingRequirements: candidate.unresolved } });
  expect(artifact.automationComposition.mappedSteps).toHaveLength(3); expect(artifact).not.toHaveProperty("emailDraft");
  expect(result.json().data.answer).toContain("have not been published, scheduled or executed"); expect(result.json().data.answer).toContain("no schedule is active");
  const state = await s.repository.snapshot(), workflows = Object.values(state.workflows); expect(workflows).toHaveLength(1);
  expect(workflows[0]).toMatchObject({ yaml: candidate.yaml, steps: 3, publishedVersion: 0, draftVersion: 1, canRun: false, trigger: { type: "manual" } });
  expect(state.schedules).toEqual({}); expect(state.executions).toEqual({}); expect(s.callTool).not.toHaveBeenCalled(); expect(s.fetchImplementation).toHaveBeenCalledOnce();
  const providerBody = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body));
  expect(providerBody.messages[0].content).toContain(CANDIDATE_PROMPT_VERSION);
  const context = JSON.parse(providerBody.messages[1].content).SERVER_DERIVED_CONTEXT_JSON;
  expect(context.automation_request).toEqual(recurringAutomationCandidateContext(candidate.request).automation_request);
});

function conditionalRecurringCandidate(withAnalysis: boolean) {
  const base = recurringCandidate("manager@example.test", withAnalysis), source = parse(base.yaml);
  const text = `${base.text} only if the declared sendReport boolean workflow input is true; otherwise do not deliver.`;
  const request = recurringDeliveryRequest(text)!;
  source.metadata.automation_request = recurringAutomationCandidateContext(request).automation_request;
  source.metadata.unresolved_requirements.push(RECURRING_DECISION_REQUIREMENT);
  source.trigger.config.inputSchema.properties.sendReport = { type: "boolean" }; source.trigger.config.inputSchema.required.push("sendReport");
  const action = (nodeId: string) => ({ kind: "action", nodeId });
  source.metadata.controlFlow = { schemaVersion: "read-control-flow/v1", root: { kind: "sequence", nodes: [
    ...source.steps.slice(0, 2).map((step: { id: string }) => action(step.id)), { kind: "if", id: "send_gate",
      predicate: { kind: "ref", source: "workflowInput", path: ["sendReport"] },
      then: { kind: "sequence", nodes: source.steps.slice(2).map((step: { id: string }) => action(step.id)) }, else: { kind: "sequence", nodes: [] } },
  ] } };
  return { text, request, source, yaml: stringify(source).trim() };
}

test.each([false, true].flatMap(analysis => [false, true].map(async => [analysis, async] as const)))(
  "recurring conditional chat analysis=%s async=%s saves/reopens exact inactive branches without executing", async (analysis, asynchronous) => {
    const candidate = conditionalRecurringCandidate(analysis), s = await setup({ bridge: true, automationTools: true, analysisTools: analysis, candidateYaml: candidate.yaml });
    const extra = asynchronous ? { delivery: "async-chat", idempotencyKey: `conditional-recurring-${analysis}-0001` } : {};
    const response = await s.send(candidate.text, extra); expect(response.statusCode, response.body).toBe(asynchronous ? 202 : 200);
    if (asynchronous) await vi.waitFor(async () => {
      const job = await s.app.inject({ method: "GET", url: `/api/chat/operations/${response.json().data.operation.id}`, headers: s.headers });
      expect(job.statusCode, job.body).toBe(200); expect(job.json().data.operation.status).toBe("ANSWERED");
    });
    const reopened = await s.app.inject({ method: "GET", url: `/api/chat/sessions/${s.sessionId}`, headers: s.headers });
    const messages = reopened.json().data.messages, artifact = messages.at(-1).artifacts;
    expect(artifact).toMatchObject({ intent: "WORKFLOW", can_execute: false, automationRequest: { decisionRequest: candidate.request.decisionRequest },
      automationComposition: { status: "CAPABILITIES_MAPPED", readyForPublication: false, scheduleActive: false } });
    expect(artifact.automationComposition.remainingRequirements).toContain(RECURRING_DECISION_REQUIREMENT);
    const state = await s.repository.snapshot(), workflow = state.workflows[artifact.workflowId]!;
    expect(workflow).toMatchObject({ yaml: candidate.yaml, publishedVersion: 0, canRun: false });
    expect(parse(workflow.yaml).metadata.controlFlow).toEqual(candidate.source.metadata.controlFlow);
    expect(messages.at(-1).text).toContain("have not been published, scheduled or executed");
    expect(state.executions).toEqual({}); expect(state.schedules).toEqual({}); expect(s.callTool).not.toHaveBeenCalled(); expect(s.fetchImplementation).toHaveBeenCalledOnce();
    const body = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body));
    expect(body.messages[0].content).toContain(CANDIDATE_PROMPT_VERSION); expect(body.messages[0].content).not.toContain(candidate.text);
    expect(JSON.parse(body.messages[1].content).SERVER_DERIVED_CONTEXT_JSON.automation_request.decision_request.originalRequest).toBe(candidate.text);
    if (asynchronous) {
      const replay = await s.send(candidate.text, extra); expect(replay.statusCode).toBe(202); expect(replay.json().data.operation.id).toBe(response.json().data.operation.id);
      expect(s.fetchImplementation).toHaveBeenCalledOnce(); expect(Object.values((await s.repository.snapshot()).workflows)).toHaveLength(1);
    }
  });
test.each(["reports", "branch-analysis", "joined-analysis", "cross-join-keys"].flatMap(mode => [false, true].map(asynchronous => [mode, asynchronous] as const)))(
  "calendar joined %s chat async=%s preserves exact inactive handoff, original request and replay without dispatch", async (mode, asynchronous) => {
    const registry = await RegistryService.load(resolve("tests/fixtures/recurring-tools.json"), resolve("tests/fixtures/rules.json"));
    const tools = recurringAnalysisTools(registry.snapshot().tools);
    const candidate = mode === "cross-join-keys" ? recurringCrossJoinWorkflow(tools) : recurringJoinWorkflow(tools, mode as "reports" | "branch-analysis" | "joined-analysis"), yaml = stringify(candidate.workflow).trim();
    const s = await setup({ bridge: true, automationTools: true, analysisTools: true, candidateYaml: yaml });
    const extra = asynchronous ? { delivery: "async-chat", idempotencyKey: "joined-recurring-" + mode + "-0001" } : {};
    const response = await s.send(candidate.text, extra); expect(response.statusCode, response.body).toBe(asynchronous ? 202 : 200);
    if (asynchronous) await vi.waitFor(async () => {
      const job = await s.app.inject({ method: "GET", url: "/api/chat/operations/" + response.json().data.operation.id, headers: s.headers });
      expect(job.statusCode, job.body).toBe(200); expect(job.json().data.operation.status).toBe("ANSWERED");
    });
    const reopened = await s.app.inject({ method: "GET", url: "/api/chat/sessions/" + s.sessionId, headers: s.headers });
    const messages = reopened.json().data.messages, artifact = messages.at(-1).artifacts, state = await s.repository.snapshot(), workflow = state.workflows[artifact.workflowId]!;
    expect(artifact).toMatchObject({ intent: "WORKFLOW", can_execute: false, automationRequest: { decisionRequest: candidate.request.decisionRequest },
      automationComposition: { status: "CAPABILITIES_MAPPED", deliveryBodyBound: true, readyForPublication: false, scheduleActive: false,
        analysis: { status: mode === "reports" || mode === "cross-join-keys" ? "NOT_REQUESTED" : "MAPPED" } } });
    expect(artifact.automationComposition.remainingRequirements).toContain(RECURRING_DECISION_REQUIREMENT);
    expect(workflow).toMatchObject({ yaml, publishedVersion: 0, canRun: false }); expect(parse(workflow.yaml).metadata.controlFlow).toEqual(candidate.workflow.metadata.controlFlow);
    const readiness = await s.app.inject({ method: "GET", url: "/api/workflows/" + workflow.id + "/readiness", headers: s.headers });
    expect(readiness.statusCode, readiness.body).toBe(200); expect(readiness.json().data.can_attempt_run).toBe(false);
    expect((await s.app.inject({ method: "POST", url: "/api/workflows/" + workflow.id + "/publish", headers: s.headers, payload: {} })).statusCode).toBe(422);
    expect(state.executions).toEqual({}); expect(state.schedules).toEqual({}); expect(s.callTool).not.toHaveBeenCalled(); expect(s.fetchImplementation).toHaveBeenCalledOnce();
    const body = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body)); expect(body.messages[0].content).toBe(systemInstructionsFor(CANDIDATE_PROMPT_VERSION));
    expect(body.messages[0].content).not.toContain(candidate.text);
    expect(JSON.parse(body.messages[1].content).SERVER_DERIVED_CONTEXT_JSON.automation_request.decision_request.originalRequest).toBe(candidate.text);
    if (asynchronous) {
      const replay = await s.send(candidate.text, extra); expect(replay.statusCode).toBe(202); expect(replay.json().data.operation.id).toBe(response.json().data.operation.id);
      const saved = await s.app.inject({ method: "GET", url: "/api/chat/sessions/" + s.sessionId, headers: s.headers }); expect(saved.json().data.messages).toEqual(messages);
      expect(s.fetchImplementation).toHaveBeenCalledOnce(); expect(Object.values((await s.repository.snapshot()).workflows)).toHaveLength(1);
    }
  });

test.each(["missing No content", "wrong recipient", "unrelated analysis", "invented No keys", "model No keys"])("unsafe joined calendar %s saves a truthful unresolved shell instead of a passing draft", async damage => {
  const registry = await RegistryService.load(resolve("tests/fixtures/recurring-tools.json"), resolve("tests/fixtures/rules.json"));
  const tools = recurringAnalysisTools(registry.snapshot().tools), candidate = damage.endsWith("No keys") ?
    recurringCrossJoinWorkflow(tools) : recurringJoinWorkflow(tools, "joined-analysis");
  if (damage === "missing No content") candidate.workflow.metadata.controlFlow.root.nodes[0].merge.else.fields.invoices = { kind: "literal", value: "Fake invoice report" };
  if (damage === "wrong recipient") candidate.workflow.steps.at(-1).parameters.recipient = "invented@example.test";
  if (damage === "unrelated analysis") candidate.workflow.steps.find((step: any) => step.kind === "analysis").input.orders = "{{gate.value.invoices}}";
  if (damage === "invented No keys") candidate.workflow.metadata.controlFlow.root.nodes[0].merge.else.fields.orderIds =
    { kind: "array", items: ["invented"].map(value => ({ kind: "literal", value })) };
  if (damage === "model No keys") candidate.workflow.metadata.controlFlow.root.nodes[0].merge.else.fields.orderIds.nodeId = "invented_analysis";
  const s = await setup({ bridge: true, automationTools: true, analysisTools: true, candidateYaml: stringify(candidate.workflow) }), response = await s.send(candidate.text);
  expect(response.statusCode, response.body).toBe(200); expect(response.json().data.assistantMessage.artifacts).toMatchObject({ compositionFailure: "COMPOSITION_UNAVAILABLE", can_execute: false });
  const state = await s.repository.snapshot(), saved = Object.values(state.workflows)[0]!;
  expect(saved.steps).toBe(0); expect(parse(saved.yaml).metadata.unresolved_requirements).toEqual(candidate.request.requirements);
  expect(parse(saved.yaml).metadata.automation_request.decision_request.originalRequest).toBe(candidate.text);
  expect(state.executions).toEqual({}); expect(state.schedules).toEqual({}); expect(s.callTool).not.toHaveBeenCalled(); expect(s.fetchImplementation).toHaveBeenCalledOnce();
});

function returningRecurringCandidate(withAnalysis: boolean) {
  const candidate = conditionalRecurringCandidate(withAnalysis);
  candidate.text += " Return the confirmed report summary after any required delivery; otherwise return the explicit no-delivery outcome.";
  candidate.request = recurringDeliveryRequest(candidate.text)!;
  candidate.source.metadata.automation_request = recurringAutomationCandidateContext(candidate.request).automation_request;
  const flow = candidate.source.metadata.controlFlow;
  flow.schemaVersion = "read-control-flow/v2";
  const gate = flow.root.nodes.at(-1);
  gate.then.nodes.push({ kind: "return", id: "report_answer", output: { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput",
    nodeId: withAnalysis ? "invoice_analysis" : "invoice_report", path: ["structuredContent", withAnalysis ? "text" : "summary"] } } });
  gate.else.nodes.push({ kind: "return", id: "not_requested_answer", output: { schema: { type: "string" }, value: { kind: "literal", value: "Explicitly not requested" } } });
  return { ...candidate, yaml: stringify(candidate.source).trim() };
}

test.each([false, true].flatMap(analysis => [false, true].map(async => [analysis, async] as const)))(
  "calendar Return chat analysis=%s async=%s saves exact inactive answers with original requirements and no dispatch", async (analysis, asynchronous) => {
    const candidate = returningRecurringCandidate(analysis), s = await setup({ bridge: true, automationTools: true, analysisTools: analysis, candidateYaml: candidate.yaml });
    const extra = asynchronous ? { delivery: "async-chat", idempotencyKey: `returning-recurring-${analysis}-0001` } : {};
    const response = await s.send(candidate.text, extra); expect(response.statusCode, response.body).toBe(asynchronous ? 202 : 200);
    if (asynchronous) await vi.waitFor(async () => {
      const job = await s.app.inject({ method: "GET", url: `/api/chat/operations/${response.json().data.operation.id}`, headers: s.headers });
      expect(job.statusCode, job.body).toBe(200); expect(job.json().data.operation.status).toBe("ANSWERED");
    });
    const reopened = await s.app.inject({ method: "GET", url: `/api/chat/sessions/${s.sessionId}`, headers: s.headers });
    const artifact = reopened.json().data.messages.at(-1).artifacts;
    expect(artifact).toMatchObject({ intent: "WORKFLOW", can_execute: false, automationRequest: { decisionRequest: candidate.request.decisionRequest },
      automationComposition: { status: "CAPABILITIES_MAPPED", readyForPublication: false, scheduleActive: false } });
    expect(artifact.automationComposition.remainingRequirements).toContain(RECURRING_DECISION_REQUIREMENT);
    const state = await s.repository.snapshot(), workflow = state.workflows[artifact.workflowId]!;
    expect(workflow).toMatchObject({ yaml: candidate.yaml, publishedVersion: 0, canRun: false });
    expect(parse(workflow.yaml).metadata.controlFlow).toEqual(candidate.source.metadata.controlFlow);
    expect(state.executions).toEqual({}); expect(state.schedules).toEqual({}); expect(s.callTool).not.toHaveBeenCalled(); expect(s.fetchImplementation).toHaveBeenCalledOnce();
    const body = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body));
    expect(body.messages[0].content).toContain("CALENDAR FINAL ANSWERS"); expect(body.messages[0].content).not.toContain(candidate.text);
    expect(JSON.parse(body.messages[1].content).SERVER_DERIVED_CONTEXT_JSON.automation_request.decision_request.originalRequest).toBe(candidate.text);
    if (asynchronous) {
      const replay = await s.send(candidate.text, extra); expect(replay.statusCode).toBe(202); expect(replay.json().data.operation.id).toBe(response.json().data.operation.id);
      expect(s.fetchImplementation).toHaveBeenCalledOnce(); expect(Object.values((await s.repository.snapshot()).workflows)).toHaveLength(1);
    }
  });

test("calendar chat cannot erase requested delivery behind an early Return or lose its unmet original intent", async () => {
  const candidate = returningRecurringCandidate(false), branch = candidate.source.metadata.controlFlow.root.nodes.at(-1).then;
  branch.nodes.unshift(branch.nodes.pop());
  const s = await setup({ bridge: true, automationTools: true, candidateYaml: stringify(candidate.source).trim() });
  const response = await s.send(candidate.text); expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.assistantMessage.artifacts).toMatchObject({ intent: "WORKFLOW", compositionFailure: "COMPOSITION_UNAVAILABLE", can_execute: false,
    automationRequest: { decisionRequest: candidate.request.decisionRequest, scheduleActive: false } });
  const state = await s.repository.snapshot(), workflow = Object.values(state.workflows)[0]!;
  expect(workflow.steps).toBe(0); expect(parse(workflow.yaml).metadata.unresolved_requirements).toEqual(candidate.request.requirements);
  expect(state.executions).toEqual({}); expect(state.schedules).toEqual({}); expect(s.callTool).not.toHaveBeenCalled(); expect(s.fetchImplementation).toHaveBeenCalledOnce();
});

test("unsafe recurring model output falls back to the empty shell and preserves every gate", async () => {
  const candidate = recurringCandidate("invented@example.test"), s = await setup({ bridge: true, automationTools: true, candidateYaml: candidate.yaml });
  const result = await s.send(candidate.text); expect(result.statusCode, result.body).toBe(200);
  const artifact = result.json().data.assistantMessage.artifacts;
  expect(artifact).toMatchObject({ intent: "WORKFLOW", compositionFailure: "COMPOSITION_UNAVAILABLE", can_execute: false,
    automationRequest: { requestedAddresses: ["manager@example.test"], scheduleActive: false } });
  expect(artifact).not.toHaveProperty("automationComposition"); expect(artifact).not.toHaveProperty("emailDraft");
  const state = await s.repository.snapshot(), workflow = Object.values(state.workflows)[0]!;
  expect(workflow.steps).toBe(0); expect(workflow.yaml).toContain("unresolved_requirements"); expect(state.schedules).toEqual({}); expect(state.executions).toEqual({});
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.fetchImplementation).toHaveBeenCalledOnce();
});
test("zero-tool model 'sent' claim cannot become a report or delivery result", async () => {
  const s = await setup({ bridge: true, final: "Email sent successfully." }); const result = await s.send();
  expect(result.json().data.assistantMessage.artifacts.emailDraft).toMatchObject({ state: "DRAFT_NOT_SENT", reportStatus: "NOT_PREPARED", body: "", sourceEvidence: [] });
  expect(result.json().data.answer).not.toContain("successfully"); expect(s.callTool).not.toHaveBeenCalled();
});
test("confirmed reads produce a review draft, not sent or approved", async () => {
  const s = await setup({ bridge: true, calls: true }); const result = await s.send();
  expect(result.statusCode, result.body).toBe(200);
  const draft = result.json().data.assistantMessage.artifacts.emailDraft;
  expect(draft).toMatchObject({ body: "Synthetic fixture report for review.", reportStatus: "PREPARED_FOR_REVIEW", state: "DRAFT_NOT_SENT" });
  expect(draft.sourceEvidence).toHaveLength(1); expect(draft.sourceEvidence[0].outputDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(s.callTool).toHaveBeenCalledExactlyOnceWith("demo.echo", { value: "fixture report", role: "admin" });
  expect(result.json().data.operation.success).toBe(false);
});

test("email preparation preserves the model's validated clarification instead of discarding it into a blank form", async () => {
  const s = await setup({ bridge: true, final: JSON.stringify({ kind: "clarification", questions: ["Do you mean sales orders or purchase orders?"] }) });
  const response = await s.send(); expect(response.statusCode).toBe(200);
  expect(response.json().data.answer).toContain("Do you mean sales orders or purchase orders?");
  expect(response.json().data.assistantMessage.artifacts.emailPreparation).toEqual({ status: "NEEDS_DETAILS", questions: ["Do you mean sales orders or purchase orders?"] });
  expect(s.callTool).not.toHaveBeenCalled();
});
test.each([{ failure: true }, { final: "I have sent the email successfully." }, { final: "x".repeat(32001) }, { finalStop: "length" }, { finalStop: "content_filter" }])("failed, unsupported, truncated or oversized report is not silently used as a complete email body: %j", async (extra) => {
  const s = await setup({ bridge: true, calls: true, ...extra }); const result = await s.send();
  expect(result.json().data.assistantMessage.artifacts.emailDraft.body).toBe("");
  expect(result.json().data.assistantMessage.artifacts.emailDraft.reportStatus).not.toBe("PREPARED_FOR_REVIEW");
  expect(s.callTool).toHaveBeenCalledTimes(1);
});
test("unadmitted registry makes no provider or SDK call", async () => {
  const s = await setup({ bridge: true, unadmitted: true }); const result = await s.send();
  expect(result.json().data.assistantMessage.artifacts.reportReason).toBe("NO_ADMITTED_READ_TOOLS"); expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});
test("provider failure after an acknowledged read preserves partial evidence without generating a complete email body", async () => {
  const s = await setup({ bridge: true, calls: true, providerFailsAfterRead: true }); const result = await s.send();
  expect(result.statusCode, result.body).toBe(200);
  const artifact = result.json().data.assistantMessage.artifacts;
  expect(artifact.reportReason).toBe("PROVIDER_FAILED"); expect(artifact.emailDraft).toMatchObject({ body: "", reportStatus: "PARTIAL", state: "DRAFT_NOT_SENT" });
  expect(artifact.emailDraft.sourceEvidence).toHaveLength(1); expect(artifact.toolSteps[0].status).toBe("SUCCEEDED");
  expect(result.body).not.toContain("private-provider-secret"); expect(s.callTool).toHaveBeenCalledTimes(1);
});
test("role change during analysis prevents returning or persisting an old-role report draft", async () => {
  const s = await setup({ bridge: true, calls: true });
  const originalFetch = s.fetchImplementation.getMockImplementation()!;
  s.fetchImplementation.mockImplementation(async (...args) => {
    const response = await originalFetch(...args);
    const input = JSON.parse(String(args[1]?.body));
    if (input.messages.some((message: { role: string }) => message.role === "tool")) await s.repository.mutate((state) => { state.users.owner!.roleId = "role_client"; });
    return response;
  });
  const result = await s.send(); expect(result.statusCode).toBe(403);
  expect(s.callTool).toHaveBeenCalledTimes(1); expect(result.body).not.toContain("fixture report");
  expect((await s.repository.snapshot()).chats[s.sessionId]?.messages).toHaveLength(1);
});
test("versioned edit is atomic, deduplicated, source-preserving and never invokes a provider or SDK", async () => {
  const s = await setup({ bridge: true, calls: true }); const initial = await s.send(); const draft = initial.json().data.assistantMessage.artifacts.emailDraft;
  s.fetchImplementation.mockClear(); s.callTool.mockClear();
  const edit = command(draft); const results = await Promise.all([s.send("", { emailDraftCommand: edit }), s.send("", { emailDraftCommand: edit })]);
  expect(results.map((result) => result.statusCode)).toEqual([200, 200]);
  expect(results[0]!.json().data.assistantMessage.id).toBe(results[1]!.json().data.assistantMessage.id);
  const updated = results[0]!.json().data.assistantMessage.artifacts.emailDraft;
  expect(updated).toMatchObject({ version: 2, state: "DRAFT_NOT_SENT", reportStatus: "USER_EDITED", to: "confirmed@example.test" });
  expect(updated.sourceEvidence).toEqual(draft.sourceEvidence); expect(updated.originalRequest).toBe(draft.originalRequest); expect(updated.contentHash).not.toBe(draft.contentHash);
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
  expect((await s.repository.snapshot()).chats[s.sessionId]?.messages).toHaveLength(4);
  const history = await s.app.inject({ method: "GET", url: `/api/chat/sessions/${s.sessionId}`, headers: s.headers });
  expect(history.json().data.messages[1].artifacts.emailDraftSuperseded).toBe(true);
  expect(history.json().data.messages[3].artifacts.emailDraftSuperseded).toBe(false);
  const replayChanged = await s.send("", { emailDraftCommand: { ...edit, patch: { ...edit.patch, body: "Different" } } }); expect(replayChanged.statusCode).toBe(409);
  const stale = await s.send("", { emailDraftCommand: command(draft, "edit-command-00000002") }); expect(stale.statusCode).toBe(409);
  const reopened = new Repository(null, await s.repository.snapshot());
  expect((await reopened.snapshot()).chats[s.sessionId]?.messages[3]?.artifacts).toMatchObject({ emailDraft: { version: 2, state: "DRAFT_NOT_SENT" } });
});
test("concurrent different edits cannot overwrite each other", async () => {
  const s = await setup(); const initial = await s.send(); const draft = initial.json().data.assistantMessage.artifacts.emailDraft;
  const results = await Promise.all([s.send("", { emailDraftCommand: command(draft) }), s.send("", { emailDraftCommand: command(draft, "edit-command-00000002") })]);
  expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
});
test.each(["foreign", "forged-state", "extra-patch", "header-injection", "invalid-recipient", "bad-hash", "revoked"])("invalid or unauthorized draft edit is rejected: %s", async (scenario) => {
  const s = await setup(); const initial = await s.send(); const draft = initial.json().data.assistantMessage.artifacts.emailDraft;
  const edit: any = command(draft);
  if (scenario === "forged-state") edit.state = "SENT";
  if (scenario === "extra-patch") edit.patch.sourceEvidence = [];
  if (scenario === "header-injection") edit.patch.subject = "Hello\r\nBcc: thief@example.test";
  if (scenario === "invalid-recipient") edit.patch.to = "not an email";
  if (scenario === "bad-hash") edit.baseHash = "sha256:" + "0".repeat(64);
  if (scenario === "revoked") await s.repository.mutate((state) => { state.users.owner!.status = "Disabled"; });
  const result = await s.send("", { emailDraftCommand: edit }, scenario === "foreign" ? "other" : "owner");
  expect(result.statusCode).toBeGreaterThanOrEqual(400); expect((await s.repository.snapshot()).chats[s.sessionId]?.messages).toHaveLength(2);
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.fetchImplementation).not.toHaveBeenCalled();
});
test("platform-admin visibility never grants another person's delivery draft creation", async () => {
  const s = await setup(); const result = await s.send(requestText, {}, "other"); expect(result.statusCode).toBe(404);
  expect((await s.repository.snapshot()).chats[s.sessionId]?.messages).toHaveLength(0);
});
test("query itself rejects no-read completion prose", async () => {
  const s = await setup({ bridge: true, final: "Email sent successfully." }); const result = await s.send("List invoices");
  expect(result.json().data.answer).toContain("No confirmed ERP data"); expect(result.json().data.answer).toContain("No email was sent"); expect(s.callTool).not.toHaveBeenCalled();
});
test("already cancelled preparation cannot call a provider or tool", async () => {
  const controller = new AbortController(); controller.abort();
  const queryWithTools = vi.fn(); const callTool = vi.fn();
  const result = await runQueryLoop({ userMessage: requestText, chatHistory: [], sessionId: "chat", actorId: "owner", actorRole: "Platform Admin", signal: controller.signal }, [], callTool, { queryWithTools } as unknown as ProviderRuntime, true);
  expect(result).toMatchObject({ stopReason: "CANCELLED", readOutcome: "NO_CONFIRMED_READ" });
  expect(queryWithTools).not.toHaveBeenCalled(); expect(callTool).not.toHaveBeenCalled();
});
test("cancellation after one acknowledged read retains it and prevents a later proposed tool", async () => {
  const controller = new AbortController();
  const queryWithTools = vi.fn(async () => ({ text: "", inputTokens: 1, outputTokens: 1, stopReason: "tool_calls", toolCalls: [
    { id: "one", name: "fixture.one", arguments: {} }, { id: "two", name: "fixture.two", arguments: {} },
  ] }));
  const callTool = vi.fn(async () => { controller.abort(); return { content: [], structuredContent: { fixture: true } }; });
  const offeredTools = ["fixture.one", "fixture.two"].map((name) => toolSchema.parse({
    tool_id: name, name, mcp_tool_name: name, description: "Cancellation fixture read",
    is_read_only: true, allowed_roles: ["Platform Admin"],
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  }));
  const result = await runQueryLoop({ userMessage: requestText, chatHistory: [], sessionId: "chat", actorId: "owner", actorRole: "Platform Admin", signal: controller.signal }, offeredTools, callTool, { queryWithTools } as unknown as ProviderRuntime, true);
  expect(result).toMatchObject({ stopReason: "CANCELLED", readOutcome: "PARTIAL_READ", boundHit: true });
  expect(result.toolSteps[0]?.status).toBe("SUCCEEDED"); expect(callTool).toHaveBeenCalledTimes(1); expect(queryWithTools).toHaveBeenCalledTimes(1);
  expect(createEmailDraft("draft", "chat", "owner", requestText, deliveryIntent(requestText)!, result)).toMatchObject({ body: "", reportStatus: "PARTIAL", state: "DRAFT_NOT_SENT" });
});
