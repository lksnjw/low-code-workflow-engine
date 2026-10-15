import { expect, test } from "vitest";
import { buildWorkflowYamlFromSteps } from "../src/agent/query-chat-presentation.js";
import { parseWorkflowYAMLStrict } from "../src/parser/workflow.js";
test("a successful ERP chat read produces a savable manual workflow draft with exact JSON-string inputs", () => {
  const yaml = buildWorkflowYamlFromSteps([{ toolName: "list_companies", arguments: { fields: '["name"]', limit_page_length: 5 },
    result: { content: [{ type: "text", text: '[{"name":"Company A"}]' }] }, status: "SUCCEEDED" }], "List company names");
  const workflow = parseWorkflowYAMLStrict(yaml);
  expect(workflow.trigger.type).toBe("manual");
  expect(workflow.steps[0]?.parameters).toEqual({ fields: '["name"]', limit_page_length: 5 });
});
