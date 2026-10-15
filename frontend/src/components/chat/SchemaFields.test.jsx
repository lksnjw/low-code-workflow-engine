/** @jest-environment jsdom */
import React, { useState } from "react";
import { test, expect, afterEach, jest } from "@jest/globals";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import SchemaFields from "./SchemaFields";
afterEach(cleanup);

test("schema descriptions clarify encoded JSON strings without turning them into arrays or markup", () => {
  const changed = jest.fn(), value = { fields: '["name"]' };
  const { container } = render(<SchemaFields schema={{ type: "object", properties: { fields: { type: "string", description: "JSON array encoded as a string. <script>not code</script>" } }, additionalProperties: false }} value={value} onChange={changed} />);
  expect(screen.getByLabelText("Parameters · fields").value).toBe('["name"]');
  expect(screen.getByText(/JSON array encoded as a string/)).toBeTruthy();
  expect(container.querySelector("script")).toBeNull(); expect(changed).not.toHaveBeenCalled();
});

test("a one-item recipient list remains a list; a mismatched scalar requires explicit replacement", () => {
  const changed = jest.fn(), contract = { type: "object", properties: { recipients: { type: "array", items: { type: "string" } } }, additionalProperties: false };
  const first = render(<SchemaFields schema={contract} value={{ recipients: ["a@example.test"] }} onChange={changed} />);
  expect(screen.getByLabelText("Parameters · recipients · Item 1").value).toBe("a@example.test");
  expect(changed).not.toHaveBeenCalled(); first.unmount();
  render(<SchemaFields schema={contract} value={{ recipients: "a@example.test" }} onChange={changed} />);
  expect(screen.getByRole("alert").textContent).toContain("does not match array");
  expect(screen.getByText("a@example.test")).toBeTruthy(); expect(changed).not.toHaveBeenCalled();
});
const schema = { type: "object", properties: { count: { type: "integer" }, title: { type: "string" }, enabled: { type: "boolean" }, rows: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } } }, required: ["count", "title"], additionalProperties: false };
const sources = [{ expression: "{{input.limit}}", label: "Workflow input · limit", binding: { kind: "ref", source: "workflowInput", path: ["limit"] }, schema: { type: "integer" } }, { expression: "{{read.structuredContent.label}}", label: "Node read · structuredContent · label", schema: { type: "string" } }];
function Harness({ initial = {}, contract = schema, onValue, ...props }) {
  const [value, setValue] = useState(initial);
  return <SchemaFields schema={contract} value={value} onChange={next => { setValue(next); onValue?.(next); }} dataSources={sources} {...props} />;
}

test("required fields are guided but absent values are not silently inserted or taken from defaults", () => {
  const changed = jest.fn(); render(<Harness contract={{ ...schema, properties: { ...schema.properties, count: { type: "integer", default: 99 } } }} onValue={changed} />);
  expect(changed).not.toHaveBeenCalled(); expect(screen.getAllByText(/Required/)).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Set count" }));
  expect(changed).toHaveBeenLastCalledWith({ count: 0 });
  expect(screen.getByRole("spinbutton", { name: "Parameters · count" }).value).toBe("0");
});

test("references use readable compatible choices, preserve structured expressions and do not claim fetched values", () => {
  const changed = jest.fn(); const { container } = render(<Harness initial={{ count: 7, title: "literal" }} onValue={changed} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Parameters · count input mode" }), { target: { value: "data" } });
  expect(changed).toHaveBeenLastCalledWith({ count: "{{input.limit}}", title: "literal" });
  const choice = screen.getByRole("combobox", { name: "Parameters · count data source" });
  expect(choice.textContent).toContain("Workflow input · limit · integer"); expect(choice.textContent).not.toContain("Node read");
  expect(screen.getByText(/resolved at runtime, not a fetched answer/)).toBeTruthy();
  expect(container.querySelector("pre, textarea")).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Parameters · count input mode" }), { target: { value: "literal" } });
  expect(changed).toHaveBeenLastCalledWith({ count: 0, title: "literal" });
});

test("invalid literals and unavailable references are retained until explicit replacement", () => {
  const changed = jest.fn(); render(<Harness initial={{ count: "bad", title: "{{future.output}}", extra: 4 }} onValue={changed} />);
  expect(screen.getByRole("alert").textContent).toContain("preserved until you explicitly replace");
  expect(screen.getByText(/Current scope or type could not be confirmed/)).toBeTruthy();
  expect(changed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Replace Parameters · count with integer" }));
  expect(changed).toHaveBeenLastCalledWith({ count: 0, title: "{{future.output}}", extra: 4 });
});

test("boolean, nested object/list and optional removal preserve unrelated arguments", () => {
  const changed = jest.fn(); render(<Harness initial={{ count: 0, title: "", enabled: false, rows: [{ id: "old" }] }} onValue={changed} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Parameters · enabled" }), { target: { value: "true" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Parameters · rows · Item 1 · id" }), { target: { value: "new" } });
  expect(changed).toHaveBeenLastCalledWith({ count: 0, title: "", enabled: true, rows: [{ id: "new" }] });
  fireEvent.click(screen.getByRole("button", { name: "Remove title" }));
  expect(changed).toHaveBeenLastCalledWith({ count: 0, enabled: true, rows: [{ id: "new" }] });
});

test("integer controls reject fractional edits without changing stored values", () => {
  const changed = jest.fn(); render(<Harness initial={{ count: 3 }} onValue={changed} />);
  fireEvent.change(screen.getByRole("spinbutton", { name: "Parameters · count" }), { target: { value: "1.5" } });
  expect(changed).not.toHaveBeenCalled();
});

test("run input strings remain literal even if they resemble workflow references", () => {
  const changed = jest.fn(); render(<Harness initial={{ title: "{{input.limit}}" }} onValue={changed} allowReferences={false} />);
  expect(screen.getByRole("textbox", { name: "Parameters · title" }).value).toBe("{{input.limit}}");
  expect(screen.queryByRole("combobox", { name: "Parameters · title data source" })).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

test("sensitive fields mask literal entry and cannot select upstream data", () => {
  const { container } = render(<Harness initial={{ title: "secret-fixture" }} contract={{ type: "object", properties: { title: { type: "string", writeOnly: true } }, additionalProperties: false }} />);
  expect(container.querySelector('input[aria-label="Parameters · title"]').type).toBe("password");
  expect(screen.queryByRole("combobox", { name: "Parameters · title input mode" })).toBeNull();
});

test("undeclared fields are preserved and visibly not allowed without silently deleting them", () => {
  const changed = jest.fn(); render(<Harness initial={{ count: 0, extra: "keep" }} onValue={changed} />);
  expect(screen.getByText("Additional fields · not allowed by this schema")).toBeTruthy();
  expect(changed).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("spinbutton", { name: "Parameters · count" }), { target: { value: "2" } });
  expect(changed).toHaveBeenLastCalledWith({ count: 2, extra: "keep" });
});

test("sensitive structured/non-text values remain hidden rather than appearing in a generic fallback", () => {
  const changed = jest.fn(); const { container } = render(<Harness initial={{ privateData: { secret: "DO_NOT_SHOW" }, pin: 123456 }} contract={{ type: "object", properties: { privateData: { type: "object", writeOnly: true, properties: { secret: { type: "string", writeOnly: true } } }, pin: { type: "integer", writeOnly: true } }, additionalProperties: false }} onValue={changed} />);
  expect(container.textContent).not.toMatch(/DO_NOT_SHOW|123456/); expect(container.querySelector("input")).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});
