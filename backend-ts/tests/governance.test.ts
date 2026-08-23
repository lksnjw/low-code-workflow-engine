import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { GovernanceAdapter } from "../src/governance/adapter.js";
import { GovernedValidationGate } from "../src/governance/gate.js";
import { GovernanceService } from "../src/governance/service.js";
import { RegistryService } from "../src/registry/service.js";
import { Repository } from "../src/repository/store.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";

const governanceURL = "https://governance.example/policy/evaluate";
const user = { id: "usr_test", role: "Platform Admin", department: "finance" };
const readOnlyYAML = `name: Read attendance\ndescription: Reads attendance without side effects.\ntrigger:\n  type: manual\nsteps:\n  - id: read\n    action: fetch_attendance\n    parameters: {}\n`;
const sideEffectYAML = `name: Create leave\ndescription: Creates a leave request.\ntrigger:\n  type: manual\nsteps:\n  - id: create\n    action: create_leave\n    parameters: {}\n`;

describe("governance adapter contract", () => {
  test("environment configuration requires a key and explicit positive cache TTL", () => {
    expect(() => loadConfig({ GOVERNANCE_URL: governanceURL })).toThrow(/GOVERNANCE_API_KEY/);
    expect(() => loadConfig({ GOVERNANCE_URL: governanceURL, GOVERNANCE_API_KEY: "key" })).toThrow(/GOVERNANCE_CACHE_TTL_MS/);
    const config = loadConfig({
      GOVERNANCE_URL: governanceURL,
      GOVERNANCE_API_KEY: "key",
      GOVERNANCE_CACHE_TTL_MS: "60000",
      GOVERNANCE_TIMEOUT_MS: "2500",
    });
    expect(config).toEqual(expect.objectContaining({ governanceURL, governanceCacheTTLms: 60_000, governanceTimeoutMs: 2_500 }));
  });

  test("posts the required request envelope to the complete configured URL and maps typed rules", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(policyResponse("opaque-version::2026/08", [
      rule("POL-1", "amount_threshold", { enabled: false }),
    ], { evidenceIds: ["ev-1"] }));
    const adapter = primaryAdapter(fetchImplementation);
    const request = {
      requestId: "req-1",
      user,
      intent: "check an amount",
      proposedActions: ["demo.echo"],
      caseContext: { caseId: "case-1" },
    };

    const result = await adapter.fetchPolicy(request);

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe(governanceURL);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ authorization: "Bearer governance-test-key", "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual(request);
    expect(result.policyVersion).toBe("opaque-version::2026/08");
    expect(result.rules[0]).toEqual(expect.objectContaining({
      rule_id: "POL-1",
      rule_type: "amount_threshold",
      enforcement_action: "block",
      enabled: false,
      condition: expect.objectContaining({ parameter: "amount", operator: "gt", value: 100 }),
    }));
  });

  test("unmappable families reject the whole fetch and name every rule ID and family", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(policyResponse("v1", [
      rule("POL-MAPPED", "amount_threshold"),
      rule("POL-UNKNOWN-1", "legal_opinion"),
      rule("POL-UNKNOWN-2", "model_discretion"),
    ]));
    const adapter = primaryAdapter(fetchImplementation);

    const error = await adapter.fetchPolicy(baseRequest()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("POL-UNKNOWN-1 (legal_opinion)");
    expect((error as Error).message).toContain("POL-UNKNOWN-2 (model_discretion)");
  });
});

describe("governance snapshot and local gate", () => {
  test("typed rules are snapshotted and the validator performs no network call while recording the verbatim policy version", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(policyResponse("release candidate / 7+opaque", []));
    const setup = await governedSetup(fetchImplementation);
    const originalValidate = setup.validator.validateAndIssueToken.bind(setup.validator);
    const validationSpy = vi.spyOn(setup.validator, "validateAndIssueToken").mockImplementation(async (...args) => {
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
      return originalValidate(...args);
    });

    const gate = await setup.gate.validateAndIssueToken("Candidate", readOnlyYAML, user, { intent: "Read attendance" });

    expect(validationSpy).toHaveBeenCalledOnce();
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(gate.result.passed).toBe(true);
    expect(gate.result.metadata.governance).toEqual(expect.objectContaining({
      status: "FRESH",
      policyVersion: "release candidate / 7+opaque",
      source: "primary",
      registryHash: setup.registries.hash(),
    }));
    const persisted = (await setup.repository.snapshot()).governancePolicy;
    expect(persisted?.lastPrimaryPolicyVersion).toBe("release candidate / 7+opaque");
  });

  test("a recommended_decision allow field cannot approve a workflow", async () => {
    const blocking = rule("POL-DENY-ADMIN", "rbac", {
      appliesToRoles: ["Platform Admin"],
      appliesToTools: ["fetch_attendance"],
    });
    const setup = await governedSetup(vi.fn<typeof fetch>().mockResolvedValue(
      policyResponse("v1", [blocking], { recommended_decision: "allow" }),
    ));

    const gate = await setup.gate.validateAndIssueToken("Candidate", readOnlyYAML, user);

    expect(gate.result.passed).toBe(false);
    expect(gate.result.failed_rules).toContain("POL-DENY-ADMIN");
    expect(gate.token).toBeNull();
  });

  test("an unmappable family rejects the complete policy set without changing the last registry snapshot", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(policyResponse("v1", [
      rule("POL-GOOD", "amount_threshold"),
      rule("POL-BAD", "unsupported_family"),
    ]));
    const setup = await governedSetup(fetchImplementation);
    const before = setup.registries.hash();

    const gate = await setup.gate.validateAndIssueToken("Candidate", readOnlyYAML, user);

    expect(gate.result.passed).toBe(false);
    expect(gate.result.errors.join(" ")).toContain("POL-BAD (unsupported_family)");
    expect(setup.registries.hash()).toBe(before);
    expect(setup.registries.snapshot().rules).toHaveLength(0);
  });
});

describe("governance failure matrix", () => {
  test("unreachable governance blocks a side-effecting workflow even with an unexpired cache", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(policyResponse("v1", []))
      .mockRejectedValueOnce(new Error("offline"));
    const setup = await governedSetup(fetchImplementation);
    await setup.gate.validateAndIssueToken("Prime", readOnlyYAML, user);

    const gate = await setup.gate.validateAndIssueToken("SideEffect", sideEffectYAML, user);

    expect(gate.result.passed).toBe(false);
    expect(gate.token).toBeNull();
    expect(gate.result.metadata.governance).toEqual(expect.objectContaining({ status: "BLOCKED", source: "cache", policyVersion: "v1" }));
  });

  test("unreachable governance permits read-only local evaluation with an unexpired cached snapshot and warning", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(policyResponse("v1", []))
      .mockRejectedValueOnce(new Error("offline"));
    const setup = await governedSetup(fetchImplementation);
    await setup.gate.validateAndIssueToken("Prime", readOnlyYAML, user);

    const gate = await setup.gate.validateAndIssueToken("ReadOnly", readOnlyYAML, user);

    expect(gate.result.passed).toBe(true);
    expect(gate.result.warnings.join(" ")).toContain("GOVERNANCE_WARNING");
    expect(gate.result.metadata.governance).toEqual(expect.objectContaining({ status: "CACHED_WARNING", source: "cache", policyVersion: "v1" }));
  });

  test("a governance timeout uses cached policy with warning for read-only and blocks side effects", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(policyResponse("v1", []))
      .mockImplementation((_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
      );
    const setup = await governedSetup(fetchImplementation, undefined, 10_000, 5);
    await setup.gate.validateAndIssueToken("Prime", readOnlyYAML, user);

    const readGate = await setup.gate.validateAndIssueToken("ReadOnly", readOnlyYAML, user);
    const writeGate = await setup.gate.validateAndIssueToken("SideEffect", sideEffectYAML, user);

    expect(readGate.result.passed).toBe(true);
    expect(readGate.result.warnings.join(" ")).toContain("timed out");
    expect(readGate.result.metadata.governance).toEqual(expect.objectContaining({ status: "CACHED_WARNING" }));
    expect(writeGate.result.passed).toBe(false);
    expect(writeGate.result.errors.join(" ")).toContain("timed out");
    expect(writeGate.result.metadata.governance).toEqual(expect.objectContaining({ status: "BLOCKED" }));
  });

  test("an unparseable response blocks both read-only and side-effecting workflows", async () => {
    const setup = await governedSetup(vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ policyVersion: "v1", rules: "free-form policy prose" }), { status: 200, headers: { "content-type": "application/json" } }),
    ));

    const readGate = await setup.gate.validateAndIssueToken("ReadOnly", readOnlyYAML, user);
    const writeGate = await setup.gate.validateAndIssueToken("SideEffect", sideEffectYAML, user);

    expect(readGate.result.passed).toBe(false);
    expect(writeGate.result.passed).toBe(false);
    expect(readGate.result.metadata.governance).toEqual(expect.objectContaining({ status: "BLOCKED" }));
    expect(writeGate.result.metadata.governance).toEqual(expect.objectContaining({ status: "BLOCKED" }));
  });

  test("an expired cache with no fresh fetch blocks both action types", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(policyResponse("v1", []))
      .mockRejectedValue(new Error("offline"));
    const setup = await governedSetup(fetchImplementation, undefined, 1);
    await setup.gate.validateAndIssueToken("Prime", readOnlyYAML, user);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));

    const readGate = await setup.gate.validateAndIssueToken("ReadOnly", readOnlyYAML, user);
    const writeGate = await setup.gate.validateAndIssueToken("SideEffect", sideEffectYAML, user);

    expect(readGate.result.passed).toBe(false);
    expect(writeGate.result.passed).toBe(false);
    expect(readGate.result.errors.join(" ")).toContain("expired");
  });

  test("a secondary response with no recorded primary is unknown: human review for read-only and block for side effects", async () => {
    const primaryFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error("primary offline"));
    const secondaryFetch = vi.fn<typeof fetch>().mockImplementation(async () => policyResponse("standby-v1", []));
    const setup = await governedSetup(primaryFetch, secondaryFetch);

    const readGate = await setup.gate.validateAndIssueToken("ReadOnly", readOnlyYAML, user);
    const writeGate = await setup.gate.validateAndIssueToken("SideEffect", sideEffectYAML, user);

    expect(readGate.result.metadata.governance).toEqual(expect.objectContaining({ status: "HUMAN_REVIEW", policyVersion: "standby-v1", source: "secondary" }));
    expect(readGate.result.failed_rules).toContain("GOVERNANCE-HUMAN-REVIEW");
    expect(writeGate.result.metadata.governance).toEqual(expect.objectContaining({ status: "BLOCKED", policyVersion: "standby-v1", source: "secondary" }));
  });

  test("a secondary response with a different version is unknown and never replaces the primary baseline", async () => {
    const primaryFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(policyResponse("primary-v1", []))
      .mockRejectedValueOnce(new Error("primary offline"));
    const secondaryFetch = vi.fn<typeof fetch>().mockResolvedValue(policyResponse("secondary-v2", []));
    const setup = await governedSetup(primaryFetch, secondaryFetch);
    await setup.gate.validateAndIssueToken("Prime", readOnlyYAML, user);

    const gate = await setup.gate.validateAndIssueToken("ReadOnly", readOnlyYAML, user);

    expect(gate.result.metadata.governance).toEqual(expect.objectContaining({ status: "HUMAN_REVIEW", policyVersion: "secondary-v2" }));
    expect((await setup.repository.snapshot()).governancePolicy?.lastPrimaryPolicyVersion).toBe("primary-v1");
  });

  test("a secondary is accepted only when its version exactly equals the last primary version", async () => {
    const primaryFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(policyResponse("exact opaque v1", []))
      .mockRejectedValueOnce(new Error("primary offline"));
    const secondaryFetch = vi.fn<typeof fetch>().mockResolvedValue(policyResponse("exact opaque v1", []));
    const setup = await governedSetup(primaryFetch, secondaryFetch);
    await setup.gate.validateAndIssueToken("Prime", readOnlyYAML, user);

    const gate = await setup.gate.validateAndIssueToken("ReadOnly", readOnlyYAML, user);

    expect(gate.result.passed).toBe(true);
    expect(gate.result.metadata.governance).toEqual(expect.objectContaining({ status: "FRESH", policyVersion: "exact opaque v1", source: "secondary" }));
  });
});

async function governedSetup(primaryFetch: typeof fetch, secondaryFetch?: typeof fetch, cacheTTLms = 10_000, timeoutMs = 1_000) {
  const repository = new Repository(null);
  const registries = await RegistryService.load(
    resolve("fixtures/parity/http/runtime/all_tools_master_registry.json"),
    resolve("tests/fixtures/rules.json"),
  );
  const validator = new RegistryValidator(registries, repository);
  const primary = new GovernanceAdapter({
    url: governanceURL,
    apiKey: "governance-test-key",
    timeoutMs,
    source: "primary",
    fetchImplementation: primaryFetch,
  });
  const secondary = secondaryFetch === undefined ? null : new GovernanceAdapter({
    url: "https://governance-standby.example/policy/evaluate",
    apiKey: "governance-test-key",
    timeoutMs: 1_000,
    source: "secondary",
    fetchImplementation: secondaryFetch,
  });
  const governance = new GovernanceService(primary, secondary, cacheTTLms, registries, repository);
  await governance.initialize();
  const gate = new GovernedValidationGate(governance, validator, registries, repository);
  return { repository, registries, validator, governance, gate };
}

function primaryAdapter(fetchImplementation: typeof fetch): GovernanceAdapter {
  return new GovernanceAdapter({
    url: governanceURL,
    apiKey: "governance-test-key",
    timeoutMs: 1_000,
    source: "primary",
    fetchImplementation,
  });
}

function baseRequest() {
  return { requestId: "req-1", user, intent: "read", proposedActions: ["fetch_attendance"], caseContext: {} };
}

function rule(id: string, family: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    family,
    condition: { field: "amount", operator: "gt", value: 100 },
    effect: "block",
    ...overrides,
  };
}

function policyResponse(policyVersion: string, rules: unknown[], extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ policyVersion, rules, ...extra }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
