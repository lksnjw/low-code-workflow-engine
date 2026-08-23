import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import parity from "../fixtures/parity/validator/evaluation-120.json" with { type: "json" };
import { RegistryService } from "../src/registry/service.js";
import { Repository } from "../src/repository/store.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";

type Fixture = {
  cases: {
    case: { id: string; yaml: string; user_role: string };
    result: { passed: boolean; failed_rules: string[]; errors: string[] };
  }[];
};

describe("120-case Go validator parity", () => {
  test("matches each verdict, fired rule list, and error list across five independent runs", async () => {
    const tools = resolve("fixtures/parity/http/runtime/all_tools_master_registry.json");
    const rules = resolve("fixtures/parity/http/runtime/all_rules_master_registry.json");
    const registries = await RegistryService.load(tools, rules);
    const validator = new RegistryValidator(registries, new Repository(null));
    const fixture = parity as Fixture;
    expect(fixture.cases).toHaveLength(120);
    const deviations: Record<string, unknown>[] = [];
    for (const item of fixture.cases) {
      const attempts = [];
      for (let run = 0; run < 5; run += 1) {
        const outcome = await validator.validateAndIssueToken(`fixture.${item.case.id}.run${run + 1}`, item.case.yaml, item.case.user_role);
        attempts.push({ passed: outcome.result.passed, failed_rules: outcome.result.failed_rules, errors: outcome.result.errors });
      }
      if (new Set(attempts.map((attempt) => JSON.stringify(attempt))).size !== 1) deviations.push({ id: item.case.id, nondeterministic: attempts });
      const actual = { result: attempts[0]! };
      if (actual.result.passed !== item.result.passed || JSON.stringify(actual.result.failed_rules) !== JSON.stringify(item.result.failed_rules) || JSON.stringify(actual.result.errors) !== JSON.stringify(item.result.errors)) {
        deviations.push({ id: item.case.id, expected: { passed: item.result.passed, failed_rules: item.result.failed_rules, errors: item.result.errors }, actual: { passed: actual.result.passed, failed_rules: actual.result.failed_rules, errors: actual.result.errors } });
      }
    }
    expect(deviations).toEqual([]);
  }, 30_000);
});
