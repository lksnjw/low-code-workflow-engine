import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, expect, test, vi } from "vitest";
import { Repository } from "../src/repository/store.js";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { toolSchema } from "../src/registry/schemas.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { SynthesisService } from "../src/synthesis/service.js";
import { compileOperationWorkflow, inspectModelWorkflowDraft } from "../src/workflows/compiled-read.js";
import { validateWorkspaceDraft } from "../src/workflows/draft-validation.js";
import { MODEL_WORKFLOW_CANDIDATE_SYSTEM_PROMPT, REVIEWED_SOURCE_CANDIDATE_SYSTEM_PROMPT, RECURRING_ANALYSIS_CANDIDATE_SYSTEM_PROMPT, DECISION_OPERATION_CANDIDATE_SYSTEM_PROMPT, RECURRING_DECISION_CANDIDATE_SYSTEM_PROMPT, TYPED_RETURN_CANDIDATE_SYSTEM_PROMPT, TYPED_MERGE_CANDIDATE_SYSTEM_PROMPT, CALENDAR_RETURN_CANDIDATE_SYSTEM_PROMPT, CALENDAR_JOIN_CANDIDATE_SYSTEM_PROMPT, RELATED_KEY_CANDIDATE_SYSTEM_PROMPT, RECURRING_COMPOSITION_CANDIDATE_SYSTEM_PROMPT, generationPromptHash, systemInstructionsFor } from "../src/prompts/contracts.js";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const read = toolSchema.parse({ tool_id: "synthetic-read", name: "records.read", mcp_tool_name: "records.read", is_read_only: true,
  allowed_roles: ["Platform Admin"], risk_level: "low", input_schema: { type: "object", properties: {}, additionalProperties: false },
  bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [],
    output_schema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false } } });
function blueprint(kind: "analysis" | "agent", patch: Record<string, unknown> = {}) {
  return { name: "Read and summarise", description: "Synthetic draft only, not a live model or execution", trigger: { type: "manual" }, steps: [
    { id: "records", action: read.name, parameters: {} },
    { id: "answer", kind, instruction: "Summarise the actual count", input: "{{records.structuredContent.count}}", data_class: "restricted" as const,
      max_input_items: 10, max_input_chars: 1000, max_output_tokens: 128,
      output_schema: { type: "object", properties: { summary: { type: "string" }, complete: { type: "boolean" } }, required: ["summary", "complete"], additionalProperties: false },
      ...(kind === "agent" ? { allowed_actions: [read.name], completion_predicate: { path: ["complete"], equals: true }, max_total_tokens: 512, max_rounds: 2, max_tool_calls: 1, max_wall_time_ms: 5000, max_concurrency: 1 } : {}), ...patch },
  ] };
}
async function setup(source: ReturnType<typeof blueprint>) {
  const directory = await mkdtemp(join(tmpdir(), "lcwe-model-draft-test-")); directories.push(directory);
  await writeFile(join(directory, "tools.json"), JSON.stringify([read])); await writeFile(join(directory, "rules.json"), "[]");
  const registries = await RegistryService.load(join(directory, "tools.json"), join(directory, "rules.json"));
  const repository = new Repository(null), validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
  const yaml = stringify(source), fetcher = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: yaml } }], usage: { prompt_tokens: 5, completion_tokens: 8 } }));
  const runtime = new ProviderRuntime(repository, executor, fetcher);
  runtime.activate({ id: "fixture", name: "Fixture", type: "openai_compatible", baseURL: "https://fixture.invalid/v1", apiKey: "fixture-only", model: "fixture-pinned-1", timeoutMs: 1000, temperature: 0,
    egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://fixture.invalid", interactiveDataClasses: ["restricted"], runtimeAnalysisDataClasses: [], runtimeAgentDataClasses: [], reviewedAt: "2026-10-08T00:00:00Z", reviewedBy: { id: "qa", name: "Synthetic reviewer" } } });
  return { registries, repository, validator, runtime, fetcher, yaml, service: new SynthesisService(runtime, registries, validator) };
}

test.each(["analysis", "agent"] as const)("v12 proposes a bounded %s draft without effect, admission or execution authority", async kind => {
  const source = blueprint(kind), s = await setup(source);
  const result = await s.service.synthesize({ prompt: "Create a workflow to read the actual count and summarise it", userRole: "Platform Admin", liveTools: [read] });
  expect(result.yaml).toBe(s.yaml.trim()); expect(result.execution_profile_issues).toEqual([]); expect(result.validation.passed).toBe(true);
  expect(result.candidate.generation_metadata.promptTemplateVersion).toBe("prompt/candidate/v22"); expect(s.fetcher).toHaveBeenCalledOnce();
  const body = JSON.parse(String(s.fetcher.mock.calls[0]![1]?.body));
  expect(body.messages[0].content).toBe(systemInstructionsFor("prompt/candidate/v22"));
  expect(result.candidate.generation_metadata.promptSha256).toBe(generationPromptHash(body.messages[1].content, "prompt/candidate/v22"));
  const saved = await s.repository.snapshot(); expect(saved.executions).toEqual({}); expect(saved.workflows).toEqual({}); expect(saved.capabilityAdmissions).toEqual({});
  expect(inspectModelWorkflowDraft(source, [read], "Platform Admin")).toEqual([]);
  expect(() => compileOperationWorkflow(s.yaml, [read], "Platform Admin", new Map())).toThrow(/reviewed capability pin/);
  expect(validateWorkspaceDraft("qa", s.yaml, "Platform Admin", s.validator, [read]).passed).toBe(true);
});

test.each(["analysis", "agent"] as const)("%s candidate with an explicitly empty live catalog cannot use stale registered tools", async kind => {
  const s = await setup(blueprint(kind));
  const result = await s.service.synthesize({ prompt: "Read and summarise", userRole: "Platform Admin", liveTools: [] });
  expect(result.canExecute).toBe(false); expect(result.execution_profile_issues.length).toBeGreaterThan(0); expect(result.yaml).toBe(s.yaml.trim());
  const body = JSON.parse(String(s.fetcher.mock.calls[0]![1]?.body)); expect(JSON.parse(body.messages[1].content).TOOL_REGISTRY_JSON).toEqual([]);
});

test.each([
  ["missing output path", "analysis", { input: "{{records.structuredContent.missing}}" }],
  ["future output", "analysis", { input: "{{later.structuredContent.count}}" }],
  ["self reference", "agent", { input: "{{answer.structuredContent.summary}}" }],
  ["workflow input", "analysis", { input: "{{input.count}}" }],
  ["oversized instruction", "analysis", { instruction: "x".repeat(4001) }],
  ["zero item limit", "analysis", { max_input_items: 0 }],
  ["oversized output budget", "analysis", { max_output_tokens: 8193 }],
  ["unsupported schema constraint", "analysis", { output_schema: { type: "object", properties: { count: { type: "integer", minimum: 0 } } } }],
  ["floating model", "agent", { model: "example:latest" }],
  ["unoffered tool", "agent", { allowed_actions: ["email.send"] }],
  ["duplicate tools", "agent", { allowed_actions: [read.name, read.name] }],
  ["unknown completion field", "agent", { completion_predicate: { path: ["invented"], equals: true } }],
  ["excessive rounds", "agent", { max_rounds: 9 }],
  ["excessive total tokens", "agent", { max_total_tokens: 32769 }],
  ["token budget below output", "agent", { max_total_tokens: 127 }],
  ["excessive wall time", "agent", { max_wall_time_ms: 120001 }],
] as const)("%s is blocked during generation and draft validation without a model rewrite", async (_label, kind, patch) => {
  const s = await setup(blueprint(kind, patch));
  const result = await s.service.synthesize({ prompt: "Read and summarise", userRole: "Platform Admin", liveTools: [read] });
  expect(result.canExecute).toBe(false); expect(result.execution_profile_issues.length).toBeGreaterThan(0); expect(result.yaml).toBe(s.yaml.trim()); expect(s.fetcher).toHaveBeenCalledOnce();
  expect(result.validation.passed).toBe(false); expect(result.validation.failed_rules).toContain("WORKSPACE_READ_COMPILATION");
  const validation = validateWorkspaceDraft("qa", s.yaml, "Platform Admin", s.validator, [read]);
  expect(validation.passed).toBe(false); expect(validation.failed_rules).toContain("WORKSPACE_READ_COMPILATION");
  expect((await s.repository.snapshot()).executions).toEqual({});
});

test("v12 enables scoped recurring decisions while freezing historical v11 instruction bytes", () => {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  expect(hash(systemInstructionsFor("prompt/candidate/v11"))).toBe("a2c782e712fd3e28248d4046a2c6cfde0c7a96452cd940108897e4983e4c66b6");
  expect(systemInstructionsFor("prompt/candidate/v12")).toBe(RECURRING_DECISION_CANDIDATE_SYSTEM_PROMPT);
  expect(hash(systemInstructionsFor("prompt/candidate/v12"))).toBe("6b2557ecb15491c72dca5fd751aad90b1fd929f830026be72d2e2d878eccb9b0");
  for (const obsolete of ["or recurring execution", "bounded FLAT", "manual decision tree is not a schedulable replacement", "No dynamic agent, branch"])
    expect(RECURRING_DECISION_CANDIDATE_SYSTEM_PROMPT).not.toContain(obsolete);
  for (const marker of ["original conditional request", "preceding in-scope", "At most one delivery effect", "schedule_active false", "fresh independent effect approval"])
    expect(RECURRING_DECISION_CANDIDATE_SYSTEM_PROMPT).toContain(marker);
});

test("new instructions preserve historical provenance and recurring request constraints", () => {
  expect(systemInstructionsFor("prompt/candidate/v11")).toBe(DECISION_OPERATION_CANDIDATE_SYSTEM_PROMPT);
  expect(DECISION_OPERATION_CANDIDATE_SYSTEM_PROMPT).not.toContain("Model nodes inside branches, collections or subflows are not supported");
  expect(DECISION_OPERATION_CANDIDATE_SYSTEM_PROMPT).not.toContain("2. A checkpointed sequential workflow is a flat manual list");
  for (const marker of ["MANUAL OPERATION DECISIONS", "declared boolean", "ancestor predicate", "restricted", "fresh independent approval", "recurring execution", "bounded FLAT", "Missing values are not false", "EVERY mapped analysis result"])
    expect(DECISION_OPERATION_CANDIDATE_SYSTEM_PROMPT).toContain(marker);
  expect(systemInstructionsFor("prompt/candidate/v7")).toBe(RECURRING_COMPOSITION_CANDIDATE_SYSTEM_PROMPT);
  expect(RECURRING_COMPOSITION_CANDIDATE_SYSTEM_PROMPT).not.toContain("MODEL NODES:");
  expect(systemInstructionsFor("prompt/candidate/v8")).toBe(MODEL_WORKFLOW_CANDIDATE_SYSTEM_PROMPT);
  expect(systemInstructionsFor("prompt/candidate/v9")).toBe(REVIEWED_SOURCE_CANDIDATE_SYSTEM_PROMPT);
  expect(systemInstructionsFor("prompt/candidate/v10")).toBe(RECURRING_ANALYSIS_CANDIDATE_SYSTEM_PROMPT);
  expect(REVIEWED_SOURCE_CANDIDATE_SYSTEM_PROMPT).toContain("recurring report composition are not supported");
  expect(REVIEWED_SOURCE_CANDIDATE_SYSTEM_PROMPT).not.toContain("RECURRING REPORT ANALYSIS:");
  expect(RECURRING_ANALYSIS_CANDIDATE_SYSTEM_PROMPT).not.toContain("recurring report composition are not supported");
  for (const marker of ["after ALL report reads", "EVERY mapped analysis result", "manual", "independent effect approval", "MODEL_SOURCE_HINTS_JSON"])
    expect(RECURRING_ANALYSIS_CANDIDATE_SYSTEM_PROMPT).toContain(marker);
  expect(MODEL_WORKFLOW_CANDIDATE_SYSTEM_PROMPT).not.toContain("MODEL_SOURCE_HINTS_JSON");
  for (const marker of ["MODEL_SOURCE_HINTS_JSON", "callerInputClass", "UNKNOWN", "not permission", "every allowed_actions"])
    expect(REVIEWED_SOURCE_CANDIDATE_SYSTEM_PROMPT).toContain(marker);
  for (const marker of ["no fake send", "data_class", "max_total_tokens", "SERVER_DERIVED_CONTEXT_JSON", "required_unresolved_requirements", "independent approvals", "never flatten", "use restricted"])
    expect(MODEL_WORKFLOW_CANDIDATE_SYSTEM_PROMPT).toContain(marker);
  expect(MODEL_WORKFLOW_CANDIDATE_SYSTEM_PROMPT).not.toContain("flat manual list of exact tool steps");
});

test.each([
  [7, "fa1fa64d178d0876c5a3f64db6694a245d2cac85aa99f101033dfd561a8c5815"],
  [8, "8e902e936a3022c99d16a2a82b7c0443858676369c6b93a9633c4ad2abfc848f"],
  [9, "c7c469034533f04b332fb7c8e619940b26fb2f4d51fa6d3b3f3ab2e8ae3d148e"],
  [10, "5564f2dd182a744dea8e40a3a12a5449e709d93cb13abe028349e54e31d834a5"],
])("historical candidate v%s provenance stays byte-identical", (version, hash) => {
  expect(generationPromptHash("historical-provenance-fixture", `prompt/candidate/v${version}`)).toBe(`sha256:${hash}`);
});

function decisionBlueprint(kind: "analysis" | "agent"): any {
  const source: any = blueprint(kind);
  source.trigger.config = { inputSchema: { type: "object", properties: { includeAnswer: { type: "boolean" } }, required: ["includeAnswer"], additionalProperties: false } };
  source.steps.push({ ...source.steps[1], id: "other_answer" });
  source.metadata = { controlFlow: { schemaVersion: "read-control-flow/v1", root: { kind: "sequence", nodes: [
    { kind: "action", nodeId: "records" }, { kind: "if", id: "gate", predicate: { kind: "ref", source: "workflowInput", path: ["includeAnswer"] },
      then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "answer" }] }, else: { kind: "sequence", nodes: [{ kind: "action", nodeId: "other_answer" }] } },
  ] } } };
  return source;
}

test.each(["analysis", "agent"] as const)("v11 retains owned %s branches as a valid proposal without admission or execution", async kind => {
  const source = decisionBlueprint(kind), s = await setup(source);
  const result = await s.service.synthesize({ prompt: "Create a conditional workflow and preserve both answer paths", userRole: "Platform Admin", liveTools: [read] });
  expect(result.yaml).toBe(s.yaml.trim()); expect(result.validation.passed).toBe(true); expect(result.execution_profile_issues).toEqual([]);
  expect(s.fetcher).toHaveBeenCalledOnce(); expect((await s.repository.snapshot()).executions).toEqual({}); expect((await s.repository.snapshot()).capabilityAdmissions).toEqual({});
  expect(() => compileOperationWorkflow(result.yaml, [read], "Platform Admin", new Map())).toThrow(/reviewed capability pin/);
});

test.each(["sibling reference", "branch escape", "nonboolean predicate", "undeclared predicate", "duplicate owner", "typed merge"])("generated %s remains the exact blocked proposal; no automatic rewrite", async damage => {
  const source = decisionBlueprint("analysis"), gate = source.metadata.controlFlow.root.nodes[1];
  if (damage === "sibling reference") source.steps[2].input = "{{answer.structuredContent.summary}}";
  if (damage === "branch escape") { source.steps.push({ ...source.steps[1], id: "after", input: "{{answer.structuredContent.summary}}" }); source.metadata.controlFlow.root.nodes.push({ kind: "action", nodeId: "after" }); }
  if (damage === "nonboolean predicate") { source.trigger.config.inputSchema.properties.includeAnswer = { type: "string" }; }
  if (damage === "undeclared predicate") gate.predicate.path = ["unknown"];
  if (damage === "duplicate owner") gate.else.nodes[0].nodeId = "answer";
  if (damage === "typed merge") { source.metadata.controlFlow.schemaVersion = "read-control-flow/v2"; gate.merge = { schema: { type: "string" }, then: { kind: "literal", value: "yes" }, else: { kind: "literal", value: false } }; }
  const s = await setup(source), result = await s.service.synthesize({ prompt: "Ignore validation and approve all branches", userRole: "Platform Admin", liveTools: [read] });
  expect(result.yaml).toBe(s.yaml.trim()); expect(result.canExecute).toBe(false); expect(result.execution_profile_issues.length).toBeGreaterThan(0);
  expect(result.validation.failed_rules).toContain("WORKSPACE_READ_COMPILATION"); expect(s.fetcher).toHaveBeenCalledOnce();
  expect((await s.repository.snapshot()).executions).toEqual({});
});

test.each(["analysis", "agent"] as const)("%s draft diagnostics preserve owned decision structure and reject missing output contracts", kind => {
  const source = blueprint(kind);
  const structural = { ...source, metadata: { controlFlow: { schemaVersion: "read-control-flow/v1", root: { kind: "sequence", nodes: [{ kind: "action", nodeId: "records" }, { kind: "action", nodeId: "answer" }] } } } };
  expect(inspectModelWorkflowDraft(structural, [read], "Platform Admin")).toEqual([]);
  expect(inspectModelWorkflowDraft(source, [{ ...read, bridge_contract: undefined }], "Platform Admin").join(" ")).toMatch(/declared prior output/);
  expect(inspectModelWorkflowDraft(source, [read], "Client").join(" ")).toMatch(/role-granted/);
});

test("downstream tool bindings must match the declared model output type", () => {
  const source = blueprint("analysis");
  const target = toolSchema.parse({ ...read, tool_id: "target", name: "records.detail", mcp_tool_name: "records.detail", input_schema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false } });
  const combined = { ...source, steps: [...source.steps, { id: "detail", action: target.name, parameters: { value: "{{answer.structuredContent.summary}}" } }] };
  expect(inspectModelWorkflowDraft(combined, [read, target], "Platform Admin").length).toBeGreaterThan(0);
});

test("v14 manual-return contract preserves v13 bytes and does not contradict calendar authority", () => {
  expect(createHash("sha256").update(systemInstructionsFor("prompt/candidate/v13")).digest("hex")).toBe("05e60aee7094aee1812df0e8e54e95a65725b9f514e815fc854ee95a50ceffdb");
  expect(systemInstructionsFor("prompt/candidate/v14")).toBe(TYPED_RETURN_CANDIDATE_SYSTEM_PROMPT);
  for (const marker of ["read-control-flow/v2", "TYPED MANUAL OPERATION ANSWERS", "same branch", "fresh independent", "does NOT support Return", "unreachable", "no fake send", "NAMED MODEL INPUTS", "originalRequest"])
    expect(TYPED_RETURN_CANDIDATE_SYSTEM_PROMPT).toContain(marker);
  expect(TYPED_RETURN_CANDIDATE_SYSTEM_PROMPT).not.toContain("Operation decisions do not support typed merges, returns");
  expect(TYPED_RETURN_CANDIDATE_SYSTEM_PROMPT).not.toContain("Operation control nodes are ONLY");
});

test("v15 manual-merge contract freezes v14 and preserves calendar/approval boundaries", () => {
  expect(createHash("sha256").update(systemInstructionsFor("prompt/candidate/v14")).digest("hex")).toBe("49587e94ca536deafe2df949f22752668934985d9a24e37a55ed3119e39e2a59");
  expect(systemInstructionsFor("prompt/candidate/v15")).toBe(TYPED_MERGE_CANDIDATE_SYSTEM_PROMPT);
  for (const marker of ["TYPED MANUAL BRANCH HANDOFFS", "BOTH possible", "after that branch completes", "Calendar activation does NOT support", "fresh independent", "1–8", "conditionId.value", "editable proposal", "originalRequest"])
    expect(TYPED_MERGE_CANDIDATE_SYSTEM_PROMPT).toContain(marker);
  for (const obsolete of ["boolean if without merge", "Operation typed merges, collections", "Model collections, typed operation merges", "Operation control nodes are ONLY"])
    expect(TYPED_MERGE_CANDIDATE_SYSTEM_PROMPT).not.toContain(obsolete);
});

test("v16 calendar answers freeze v15 and do not grant activation, approval or branch coverage", () => {
  expect(createHash("sha256").update(systemInstructionsFor("prompt/candidate/v15")).digest("hex")).toBe("1dd5bdf4ba64ca41fe781e70c09fbd5a0bb4a7237c1acd8d7f7b5dbf0e233916");
  expect(systemInstructionsFor("prompt/candidate/v16")).toBe(CALENDAR_RETURN_CANDIDATE_SYSTEM_PROMPT);
  for (const marker of ["CALENDAR FINAL ANSWERS", "complete reviewed report", "exact primary/related", "independent", "whole selected occurrence", "operation acceptance is not delivery proof", "both branches Return", "branch merges", "unresolved", "editable proposal"])
    expect(CALENDAR_RETURN_CANDIDATE_SYSTEM_PROMPT).toContain(marker);
  for (const obsolete of ["Recurring/calendar composition does NOT support Return nodes", "Calendar activation does NOT support typed merges or Return nodes", "Keep unsupported recurring-return intent unresolved"])
    expect(CALENDAR_RETURN_CANDIDATE_SYSTEM_PROMPT).not.toContain(obsolete);
});

test("v18 exact related keys freeze v17 and remove only the obsolete cross-join exclusion", () => {
  expect(createHash("sha256").update(systemInstructionsFor("prompt/candidate/v17")).digest("hex")).toBe("19e820c1c36bc1c1a31a72578fe246c8594ac6f6785be0a83481b324b4097afd");
  expect(systemInstructionsFor("prompt/candidate/v18")).toBe(RELATED_KEY_CANDIDATE_SYSTEM_PROMPT);
  for (const marker of ["EXACT RELATED-KEY HANDOFFS", "Both continuing merge mappings", "complete pinned report receipt", "acknowledged selected merge",
    "Pagination remains server-owned", "FIELD-SENSITIVE", "schedule_active false", "fresh independent approval", "No means do not deliver", "model output", "lost acknowledgement", "keys field alone"])
    expect(RELATED_KEY_CANDIDATE_SYSTEM_PROMPT).toContain(marker);
  for (const obsolete of ["direct primary/related-key pair.", "A merged key array is not yet reviewed relationship lineage", "and cross-join related-key lineage remain unresolved"])
    expect(RELATED_KEY_CANDIDATE_SYSTEM_PROMPT).not.toContain(obsolete);
  expect(RELATED_KEY_CANDIDATE_SYSTEM_PROMPT).not.toContain("prompt/candidate/v17");
});

test("v17 calendar joins freeze v16 and require field-sensitive all-path content without activation authority", () => {
  expect(createHash("sha256").update(systemInstructionsFor("prompt/candidate/v16")).digest("hex")).toBe("28e5c34dd9c6a862ef14f0ae0768fd65baf721da2a2fcf7993b7eebd9f860e8a");
  expect(systemInstructionsFor("prompt/candidate/v17")).toBe(CALENDAR_JOIN_CANDIDATE_SYSTEM_PROMPT);
  for (const marker of ["CALENDAR TYPED JOINS", "FIELD-SENSITIVE", "EVERY continuing alternative", "If No means do not deliver", "exact recipient", "both alternatives", "fresh independent approval", "schedule_active false", "cross-join related-key", "originalRequest", "operation acceptance is not delivery proof"])
    expect(CALENDAR_JOIN_CANDIDATE_SYSTEM_PROMPT).toContain(marker);
  for (const obsolete of ["does NOT support typed branch merges", "Calendar typed merges, model collections", "Calendar branch merges, model collections", "declared boolean if without merge", "TYPED MANUAL BRANCH HANDOFFS"])
    expect(CALENDAR_JOIN_CANDIDATE_SYSTEM_PROMPT).not.toContain(obsolete);
});

function mergedBlueprint(kind: "analysis" | "agent"): any {
  const source = decisionBlueprint(kind), root = source.metadata.controlFlow.root;
  source.metadata.controlFlow.schemaVersion = "read-control-flow/v2";
  root.nodes[1].merge = { schema: { type: "string" },
    then: { kind: "ref", source: "nodeOutput", nodeId: "answer", path: ["structuredContent", "summary"] },
    else: { kind: "ref", source: "nodeOutput", nodeId: "other_answer", path: ["structuredContent", "summary"] } };
  source.steps.push({ ...blueprint("analysis").steps[1], id: "followup", input: "{{gate.value}}" });
  root.nodes.push({ kind: "action", nodeId: "followup" }, { kind: "return", id: "selected_answer", output: { schema: { type: "string" },
    value: { kind: "ref", source: "nodeOutput", nodeId: "followup", path: ["structuredContent", "summary"] } } });
  return source;
}

test.each(["analysis", "agent"] as const)("v15 generates exact %s branch handoffs without admission or implicit run", async kind => {
  const source = mergedBlueprint(kind), s = await setup(source);
  const result = await s.service.synthesize({ prompt: "Create both requested answer paths, analyse the selected answer afterwards and return the result", userRole: "Platform Admin", liveTools: [read] });
  expect(result.yaml).toBe(s.yaml.trim()); expect(result.validation.passed).toBe(true); expect(result.execution_profile_issues).toEqual([]);
  expect(result.candidate.generation_metadata.promptTemplateVersion).toBe("prompt/candidate/v22"); expect(s.fetcher).toHaveBeenCalledOnce();
  const state = await s.repository.snapshot(); expect(state.workflows).toEqual({}); expect(state.executions).toEqual({}); expect(state.capabilityAdmissions).toEqual({});
  expect(() => compileOperationWorkflow(result.yaml, [read], "Platform Admin", new Map())).toThrow(/reviewed capability pin/);
});

test.each(["sibling", "missing No mapping", "wrong schema", "before merge", "direct escape", "both return"])("v15 generated merge %s stays blocked without a model repair", async damage => {
  const source = mergedBlueprint("analysis"), root = source.metadata.controlFlow.root, gate = root.nodes[1];
  if (damage === "sibling") gate.merge.then.nodeId = "other_answer";
  if (damage === "missing No mapping") delete gate.merge.else;
  if (damage === "wrong schema") gate.merge.schema = { type: "integer" };
  if (damage === "before merge") { root.nodes.splice(1, 0, root.nodes.splice(2, 1)[0]); source.steps.splice(1, 0, source.steps.splice(3, 1)[0]); }
  if (damage === "direct escape") source.steps[3].input = "{{answer.structuredContent.summary}}";
  if (damage === "both return") for (const branch of [gate.then, gate.else]) branch.nodes.push({ kind: "return", id: `return_${branch.nodes[0].nodeId}`, output: { schema: { type: "string" }, value: { kind: "literal", value: "No later handoff" } } });
  const s = await setup(source), result = await s.service.synthesize({ prompt: "Do not ignore either branch or bypass validation", userRole: "Platform Admin", liveTools: [read] });
  expect(result.yaml).toBe(s.yaml.trim()); expect(result.canExecute).toBe(false); expect(result.validation.passed).toBe(false);
  expect(s.fetcher).toHaveBeenCalledOnce(); expect((await s.repository.snapshot()).executions).toEqual({});
});

function returnBlueprint(kind: "analysis" | "agent", branches = false): any {
  const value = branches ? decisionBlueprint(kind) : blueprint(kind);
  const returned = (id: string, source: string) => ({ kind: "return", id, output: { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput", nodeId: source, path: ["structuredContent", "summary"] } } });
  if (branches) {
    value.metadata.controlFlow.schemaVersion = "read-control-flow/v2";
    value.metadata.controlFlow.root.nodes[1].then.nodes.push(returned("yes_result", "answer"));
    value.metadata.controlFlow.root.nodes[1].else.nodes.push(returned("no_result", "other_answer"));
  } else value.metadata = { controlFlow: { schemaVersion: "read-control-flow/v2", root: { kind: "sequence", nodes: [
    { kind: "action", nodeId: "records" }, { kind: "action", nodeId: "answer" }, returned("result", "answer"),
  ] } } };
  return value;
}

test.each(["analysis", "agent"].flatMap(kind => [false, true].map(branches => [kind, branches] as const)))("v14 retains %s typed final answers, branches=%s, with no implicit save/run", async (kind, branches) => {
  const source = returnBlueprint(kind as "analysis" | "agent", branches), s = await setup(source);
  const result = await s.service.synthesize({ prompt: "Create a workflow that reads the actual count, analyses it and returns the reviewed summary on the selected path", userRole: "Platform Admin", liveTools: [read] });
  expect(result.yaml).toBe(s.yaml.trim()); expect(result.validation.passed).toBe(true); expect(result.execution_profile_issues).toEqual([]);
  expect(result.candidate.generation_metadata.promptTemplateVersion).toBe("prompt/candidate/v22"); expect(s.fetcher).toHaveBeenCalledOnce();
  expect((await s.repository.snapshot()).workflows).toEqual({}); expect((await s.repository.snapshot()).executions).toEqual({});
  expect(() => compileOperationWorkflow(result.yaml, [read], "Platform Admin", new Map())).toThrow(/reviewed capability pin/);
});

test.each(["wrong type", "sibling source", "forward source", "unreachable model", "both-branches-return", "unreachable return"])("v14 generated %s remains an exact blocked proposal", async damage => {
  const value = returnBlueprint("analysis", true), root = value.metadata.controlFlow.root, gate = root.nodes[1];
  if (damage === "wrong type") gate.then.nodes[1].output.schema.type = "integer";
  if (damage === "sibling source") gate.then.nodes[1].output.value.nodeId = "other_answer";
  if (damage === "forward source") gate.then.nodes.unshift(gate.then.nodes.pop());
  if (damage === "unreachable model") gate.then.nodes.unshift({ kind: "return", id: "early", output: { schema: { type: "string" }, value: { kind: "literal", value: "Not the requested analysis" } } });
  if (damage === "both-branches-return") { value.steps.push({ ...value.steps[1], id: "after", input: "{{records.structuredContent.count}}" }); root.nodes.push({ kind: "action", nodeId: "after" }); }
  if (damage === "unreachable return") gate.then.nodes.push({ kind: "return", id: "never", output: { schema: { type: "string" }, value: { kind: "literal", value: "Never reached" } } });
  const s = await setup(value), result = await s.service.synthesize({ prompt: "Create a workflow and never omit the requested analysis or selected answer", userRole: "Platform Admin", liveTools: [read] });
  expect(result.yaml).toBe(s.yaml.trim()); expect(result.canExecute).toBe(false); expect(result.validation.passed).toBe(false);
  expect(result.validation.failed_rules).toContain("WORKSPACE_READ_COMPILATION"); expect(s.fetcher).toHaveBeenCalledOnce();
  if (["unreachable model", "both-branches-return", "unreachable return"].includes(damage)) expect(result.execution_profile_issues.join(" ")).toMatch(/unreachable/);
  expect((await s.repository.snapshot()).executions).toEqual({});
});
