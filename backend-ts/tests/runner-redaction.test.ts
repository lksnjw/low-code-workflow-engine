import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import type { AnalysisProvider } from "../src/analysisprovider/types.js";
import type { Workflow } from "../src/models/schemas.js";
import { RegistryService } from "../src/registry/service.js";
import { Repository } from "../src/repository/store.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";

describe("runner output redaction", () => {
  test("removes credential-shaped analysis fields before state and timeline insertion", async () => {
    const registries = await RegistryService.load(
      resolve("tests/fixtures/tools.json"),
      resolve("tests/fixtures/rules.json"),
    );
    const validator = new RegistryValidator(registries, new Repository());
    const tools = new ToolRegistry();
    tools.register({
      name: "demo.echo",
      description: "Echoes a safe value for the analysis fixture.",
      /*******************************************************************************
       * Function: execute
       *
       * Returns a stub tool result containing values used by redaction tests.
       ******************************************************************************/
      async execute() {
        return { output: { value: "input" } };
      },
    });
    const executor = new Executor(tools, validator);
    const provider: AnalysisProvider = {
      /*******************************************************************************
       * Function: generate
       *
       * Returns a stub analysis response for the runner redaction test.
       ******************************************************************************/
      async generate() {
        return {
          text: JSON.stringify({
            summary: "visible",
            token: "must-not-escape",
            nested: { status: "ok", auth_header: "must-not-escape" },
          }),
          provider: "test",
          model: "test-model",
          inputTokens: 1,
          outputTokens: 1,
          measured: true,
        };
      },
    };
    executor.setAnalysisProvider(provider, "test-model");
    const yaml = `name: analysis_redaction\ndescription: Verify analysis output redaction.\ntrigger:\n  type: manual\nsteps:\n  - id: echo\n    action: demo.echo\n    parameters:\n      value: input\n  - id: summarize\n    kind: analysis\n    instruction: Summarize the input.\n    input: "{{echo.output}}"\n    output_schema:\n      type: object\n      required: [summary]\n      properties:\n        summary: { type: string }\n`;
    const workflow = workflowRecord(yaml);
    const validated = await validator.validateAndIssueToken(
      "runner-redaction-test",
      yaml,
      "Workflow Builder",
    );
    expect(
      validated.result.passed,
      JSON.stringify(validated.result, null, 2),
    ).toBe(true);
    expect(validated.token).not.toBeNull();

    const result = await executor.run(
      "run_analysis_redaction",
      workflow,
      { value: "input" },
      validated.token,
      Object.freeze({
        userId: "usr_builder",
        localRole: "Workflow Builder",
        erpbridgeRole: "workflow_builder",
      }),
    );

    expect(result.state.summarize).toEqual({
      output: { summary: "visible", nested: { status: "ok" } },
    });
    expect(result.timeline[1]?.output).toEqual({
      summary: "visible",
      nested: { status: "ok" },
    });
    expect(JSON.stringify(result.state)).not.toContain("must-not-escape");
    expect(JSON.stringify(result.timeline)).not.toContain("must-not-escape");
  });
});

/*******************************************************************************
 * Function: workflowRecord
 *
 * Builds a workflow record from the supplied test YAML.
 ******************************************************************************/
function workflowRecord(yaml: string): Workflow {
  const timestamp = new Date().toISOString();
  return {
    id: "wf_analysis_redaction",
    name: "analysis_redaction",
    description: "Verify analysis output redaction.",
    owner: { id: "usr_builder", name: "Workflow Builder" },
    assignedUserIds: null,
    status: "DRAFT",
    trigger: { type: "manual" },
    steps: 2,
    successRate: 0,
    lastRunAt: null,
    publishedVersion: 1,
    draftVersion: 1,
    tags: null,
    domainTags: null,
    canRun: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    yaml,
    archived: false,
  };
}
