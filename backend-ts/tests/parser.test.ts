import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseWorkflowYAMLStrict, resolveVariables } from "../src/parser/workflow.js";

type ParserFixture = { id: string; kind: string; input: unknown; output?: unknown; error?: string };
const fixtures = JSON.parse(await readFile("fixtures/parity/parser/cases.json", "utf8")) as ParserFixture[];

describe("Go parser parity fixtures", () => {
  for (const fixture of fixtures.filter((item) => item.kind === "template-resolution")) {
    it(fixture.id, () => {
      const state = { input: { name: "Ada", count: 7, enabled: false, nothing: null, object: { key: "value" }, items: [1, "two"] }, prior: { output: { summary: "done" } } };
      expect(resolveVariables(fixture.input, state)).toEqual(fixture.output);
    });
  }

  for (const fixture of fixtures.filter((item) => item.kind === "strict-yaml")) {
    it(fixture.id, () => {
      if (fixture.error !== undefined) expect(() => parseWorkflowYAMLStrict(String(fixture.input))).toThrow();
      else expect(parseWorkflowYAMLStrict(String(fixture.input))).toEqual(fixture.output);
    });
  }
});
