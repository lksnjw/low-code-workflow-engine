import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RegistryService } from "../src/registry/service.js";
import { Repository } from "../src/repository/store.js";
import { createGovernedMCPClient } from "../src/tools/mcp-client.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";

const workflowYAML = `name: capability_test
description: Verify the runtime capability boundary.
trigger:
  type: manual
steps:
  - id: echo
    action: demo.echo
    parameters:
      value: ok
`;

async function fixture(ttl = 30_000) {
  const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, new Repository(), ttl);
  let requests = 0;
  const client = createGovernedMCPClient({
    baseURL: "https://mcp.invalid",
    timeoutMs: 1_000,
    mode: "remote",
    validator,
    fetchImplementation: async () => {
      requests += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const issue = async () => {
    const { token, result } = await validator.validateAndIssueToken("test", workflowYAML, "Workflow Builder");
    expect(result.passed).toBe(true);
    expect(token).not.toBeNull();
    const params = { value: "ok", _action: "demo.echo" };
    const evaluated = await validator.evaluateResolvedStep("dispatch.test", workflowYAML, 0, params, token);
    expect(evaluated.violation).toBeNull();
    expect(evaluated.capability).not.toBeNull();
    return { capability: evaluated.capability!, params };
  };
  return { validator, client, issue, requests: () => requests };
}

describe("runtime dispatch capability", () => {
  it("rejects a forged shape without transport", async () => {
    const test = await fixture();
    await expect(test.client.execute("demo.echo", Object.freeze({}) as object, { value: "ok", _action: "demo.echo" })).rejects.toThrow("not minted");
    expect(test.requests()).toBe(0);
  });

  it("rejects parameters changed after minting without transport", async () => {
    const test = await fixture();
    const issued = await test.issue();
    await expect(test.client.execute("demo.echo", issued.capability, { ...issued.params, value: "changed" })).rejects.toThrow("parameter hash mismatch");
    expect(test.requests()).toBe(0);
  });

  it("permits one exact request and rejects reuse", async () => {
    const test = await fixture();
    const issued = await test.issue();
    await expect(test.client.execute("demo.echo", issued.capability, issued.params)).resolves.toEqual({ ok: true });
    expect(test.requests()).toBe(1);
    await expect(test.client.execute("demo.echo", issued.capability, issued.params)).rejects.toThrow("already been consumed");
    expect(test.requests()).toBe(1);
  });

  it("rejects an expired capability without transport", async () => {
    const test = await fixture(-1);
    const issued = await test.issue();
    await expect(test.client.execute("demo.echo", issued.capability, issued.params)).rejects.toThrow("expired");
    expect(test.requests()).toBe(0);
  });

  it("rejects an action mismatch without transport", async () => {
    const test = await fixture();
    const issued = await test.issue();
    await expect(test.client.execute("different.action", issued.capability, issued.params)).rejects.toThrow("action mismatch");
    expect(test.requests()).toBe(0);
  });

  it("freezes minted capabilities and rejects a cloned mutation without transport", async () => {
    const test = await fixture();
    const issued = await test.issue();
    expect(Object.isFrozen(issued.capability)).toBe(true);
    const mutated = { ...(issued.capability as Record<string, unknown>), action: "different.action" };
    await expect(test.client.execute("different.action", mutated, issued.params)).rejects.toThrow("not minted");
    expect(test.requests()).toBe(0);
  });

  it("stops a missing validation token before capability minting and transport", async () => {
    const test = await fixture();
    const outcome = await test.validator.evaluateResolvedStep("dispatch.test", workflowYAML, 0, { value: "ok", _action: "demo.echo" }, null);
    expect(outcome.capability).toBeNull();
    expect(outcome.violation?.ruleId).toBe("VALIDATION_TOKEN_INVALID");
    expect(test.requests()).toBe(0);
  });

  it("stops workflow-content mismatch before capability minting and transport", async () => {
    const test = await fixture();
    const issued = await test.validator.validateAndIssueToken("test", workflowYAML, "Workflow Builder");
    const outcome = await test.validator.evaluateResolvedStep("dispatch.test", `${workflowYAML}\n# changed`, 0, { value: "ok", _action: "demo.echo" }, issued.token);
    expect(outcome.capability).toBeNull();
    expect(outcome.violation?.ruleId).toBe("WORKFLOW_CONTENT_MISMATCH");
    expect(test.requests()).toBe(0);
  });

  it("stops registry mismatch before capability minting and transport", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lcwe-capability-"));
    try {
      const toolPath = join(directory, "tools.json");
      const rulePath = join(directory, "rules.json");
      const originalTools = (await import("./fixtures/tools.json", { with: { type: "json" } })).default;
      await writeFile(toolPath, `${JSON.stringify(originalTools, null, 2)}\n`, "utf8");
      await writeFile(rulePath, "[]\n", "utf8");
      const registries = await RegistryService.load(toolPath, rulePath);
      const validator = new RegistryValidator(registries, new Repository());
      const issued = await validator.validateAndIssueToken("test", workflowYAML, "Workflow Builder");
      await registries.upsertTool({ ...registries.snapshot().tools[0], description: "registry changed" }, true);
      const outcome = await validator.evaluateResolvedStep("dispatch.test", workflowYAML, 0, { value: "ok", _action: "demo.echo" }, issued.token);
      expect(outcome.capability).toBeNull();
      expect(outcome.violation?.ruleId).toBe("REGISTRY_MISMATCH");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops an over-threshold resolved value before transport", async () => {
    const test = await fixtureWithRules([thresholdRule()]);
    try {
      const yaml = workflowYAML.replace("value: ok", 'value: "{{input.value}}"');
      const issued = await test.validator.validateAndIssueToken("test", yaml, "Workflow Builder");
      expect(issued.result.passed).toBe(true);
      const outcome = await test.validator.evaluateResolvedStep("dispatch.test", yaml, 0, { value: 101, _action: "demo.echo" }, issued.token);
      expect(outcome.capability).toBeNull();
      expect(outcome.violation?.ruleId).toBe("TEST-THRESHOLD-001");
      expect(test.requests()).toBe(0);
    } finally { await test.cleanup(); }
  });

  it("stops credential-shaped resolved keys before transport", async () => {
    const test = await fixture();
    const issued = await test.validator.validateAndIssueToken("test", workflowYAML, "Workflow Builder");
    const outcome = await test.validator.evaluateResolvedStep("dispatch.test", workflowYAML, 0, { value: "ok", api_key: "secret", _action: "demo.echo" }, issued.token);
    expect(outcome.capability).toBeNull();
    expect(outcome.violation?.ruleId).toBe("GLOBAL-SAFETY-002");
    expect(test.requests()).toBe(0);
  });
});

async function fixtureWithRules(rules: Record<string, unknown>[]) {
  const directory = await mkdtemp(join(tmpdir(), "lcwe-capability-rules-"));
  const toolPath = join(directory, "tools.json");
  const rulePath = join(directory, "rules.json");
  const tools = (await import("./fixtures/tools.json", { with: { type: "json" } })).default;
  await writeFile(toolPath, `${JSON.stringify(tools, null, 2)}\n`, "utf8");
  await writeFile(rulePath, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
  const registries = await RegistryService.load(toolPath, rulePath);
  const validator = new RegistryValidator(registries, new Repository());
  let requests = 0;
  const client = createGovernedMCPClient({ baseURL: "https://mcp.invalid", timeoutMs: 1_000, mode: "remote", validator, fetchImplementation: async () => { requests += 1; return new Response("{}"); } });
  return { validator, client, requests: () => requests, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function thresholdRule(): Record<string, unknown> {
  return {
    rule_id: "TEST-THRESHOLD-001", rule_name: "Resolved value threshold", rule_type: "amount_threshold", domain: "demo",
    description: "Block resolved values above 100", applies_to_tools: ["demo.echo"], applies_to_roles: [],
    condition: { type: "parameter", parameter: "value", operator: ">", value: 100 }, enforcement_action: "block", severity: "high",
    validator_message: "Resolved value exceeds threshold", llm_prompt_instruction: "", healing_guidance: "", bpi_alignment: [], audit_fields_required: [], enabled: true,
  };
}
