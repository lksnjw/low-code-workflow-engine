import { expect, test } from "vitest";
import { toolSchema } from "../src/registry/schemas.js";
import { validateToolArguments } from "../src/agent/workflow-runtime-validator.js";
const tool = toolSchema.parse({ name: "list_companies", is_read_only: true, input_schema: { type: "object", properties: { fields: { type: "string" }, name: { type: "string" } } } });
test("declared string parameters may carry concrete JSON arrays and objects required by ERP APIs", () => {
  for (const fields of ['["name"]', '["name","country"]', "[]", '{"country":"Sri Lanka"}'])
    expect(validateToolArguments(tool.name, { fields }, tool).invalid).toEqual([]);
});
test.each(["[employee_id]", "<employee_id>", "{company}", "TODO", '["<employee_id>"]', '{"id":"your_employee_id"}', '["placeholder"]'])
  ("unresolved placeholder %s stays blocked", fields => expect(validateToolArguments(tool.name, { fields }, tool).invalid).not.toEqual([]));
test("JSON-string exception does not coerce array arguments or undeclared types", () => {
  expect(validateToolArguments(tool.name, { fields: ["name"] }, tool).invalid).not.toEqual([]);
  expect(validateToolArguments(tool.name, { other: '["name"]' }, tool).invalid).not.toEqual([]);
});
