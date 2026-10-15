import { expect, test } from "vitest";
import { erpChatPresentation } from "../src/agent/erp-chat-presentation.js";
import { erpChatInputIssues } from "../src/tools/erp-chat-input.js";
const chart = 'Two items.<vis>{"type":"bar","title":"Stock","data":[{"label":"Item A","value":2}]}</vis>';
test("confirmed numeric analysis keeps the graph without raw markup or a workflow", () => {
  expect(erpChatPresentation(chart, true, false, false)).toEqual({ text: "Two items.", visualisation: { type: "bar", title: "Stock", data: [{ label: "Item A", value: 2 }] } });
});
test.each([[false, false, false], [true, true, false], [true, false, true]])("incomplete read/proposal context never becomes a graph", (read, blocked, proposal) => {
  expect(erpChatPresentation(chart, read!, blocked!, proposal!)).not.toHaveProperty("visualisation");
});
test("model prose cannot acknowledge effects from a read-only request", () => {
  expect(erpChatPresentation("I updated the record.", true, false, false).text).toContain("claimed a change that this request did not execute");
});
test.each(["", "<item_id>", "TODO"])("blank/placeholder mandatory input %s is not dispatchable", name => {
  expect(erpChatInputIssues({ name: "get_item", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }, { name }).length).toBeGreaterThan(0);
});
test("a mandatory JSON-string contract validates the actual encoded content", () => {
  const tool = { name: "list_items", inputSchema: { type: "object", properties: { fields: { type: "string", description: "JSON array of requested fields" } }, required: ["fields"] } };
  expect(erpChatInputIssues(tool, { fields: '["name"]' })).toEqual([]);
  expect(erpChatInputIssues(tool, { fields: "name" })).not.toEqual([]);
  expect(erpChatInputIssues(tool, { fields: '{}' })).not.toEqual([]);
});
