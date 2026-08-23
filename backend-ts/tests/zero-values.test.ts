import { describe, expect, test } from "vitest";
import cases from "../fixtures/parity/zero-values/cases.json" with { type: "json" };
import { effectiveStepKind } from "../src/models/schemas.js";
import { Repository } from "../src/repository/store.js";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";

describe("Go zero-value semantics", () => {
  test("covers all eight captured zero-value cases", () => { expect(cases).toHaveLength(8); });
  test("blank step kind means tool", () => { expect(effectiveStepKind({ id: "step", kind: "", action: "demo.echo" })).toBe("tool"); });
  test("empty tool status and empty allowed roles remain executable", async () => {
    const registries = await RegistryService.load("tests/fixtures/tools.json", "tests/fixtures/rules.json");
    const validator = new RegistryValidator(registries, new Repository());
    const result = validator.validatePlan("zero-values", "name: zero\ndescription: Zero value semantics.\ntrigger:\n  type: manual\nsteps:\n  - id: echo\n    action: demo.echo\n    parameters: {}\n", "Client");
    expect(result.passed).toBe(true);
  });
  test("a null persistence backend is explicit memory mode", async () => { expect((await new Repository(null).persistenceStatus()).durable).toBe(false); });
  test("empty permission overrides survive repository snapshots", async () => {
    const repository = new Repository();
    await repository.mutate((state) => { state.users.test = { id: "test", name: "Test", email: "test@example.test", roleId: "missing", permissionOverrides: [], status: "Active", initials: "T", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() }; });
    expect((await repository.snapshot()).users.test?.permissionOverrides).toEqual([]);
  });
});
