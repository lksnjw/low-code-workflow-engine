import { expect, test } from "@jest/globals";
import { documentReviewIssues as issues } from "./documentReviewValidation";
const schema = { fields: [{ name: "name", type: "string", required: true }, { name: "id", type: "string", required: true, generated: true },
  { name: "quantity", type: "integer" }, { name: "enabled", type: "boolean" }, { name: "email", type: "email" }, { name: "date", type: "date" }, { name: "price", type: "number" }] };
test("missing/blank required fields are listed and generated keys stay optional", () => {
  expect(issues(schema, { name: "  " })).toEqual(["name is required."]);
  expect(issues(schema, { name: "QA", quantity: 0, enabled: false })).toEqual([]);
});
test.each([{ quantity: 1.2 }, { quantity: "2" }, { price: Infinity }, { enabled: "false" }, { email: "wrong" }, { date: "2026-02-30" }, { name: "x".repeat(4001) }])("bad field types cannot enable confirmation: %j", invalid => {
  expect(issues(schema, { name: "QA", ...invalid }).length).toBeGreaterThan(0);
});
test("valid optional values and real leap dates pass", () => {
  expect(issues(schema, { name: "QA", date: "2028-02-29", email: "qa@example.test", price: 0.5 })).toEqual([]);
});
test("batch issues identify the exact row and keep unknown fields visible", () => {
  expect(issues(schema, {}, [{ name: "QA" }, { other: 1 }])).toEqual(["Row 2: other is not in the selected schema. Prepare a new review or select the correct schema.", "Row 2: name is required."]);
  expect(issues(schema, {}, [])).toEqual(["Add at least one reviewed row."]);
  expect(issues(schema, {}, Array.from({ length: 51 }, () => ({ name: "QA" })))).toEqual(["Review no more than 50 rows at a time."]);
});
