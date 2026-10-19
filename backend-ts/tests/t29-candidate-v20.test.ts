import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CANDIDATE_PROMPT_VERSION } from "../src/providers/runtime.js";
import { generationPromptHash, systemInstructionsFor } from "../src/prompts/contracts.js";
import { SynthesisService } from "../src/synthesis/service.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { Repository } from "../src/repository/store.js";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { toolSchema } from "../src/registry/schemas.js";

afterEach(() => vi.restoreAllMocks());

const caveats = [
  "This is a local QA synthetic read and is not production data.",
  "The tool output has no declared department fields, so downstream mapping is unavailable.",
];
const caveatYaml = (description: string, unresolved: boolean) => `name: Department lookup\ndescription: ${description}\ntrigger: {type: manual}\nsteps:\n  - id: departments\n    action: synthetic.departments\n    parameters: {}\n${unresolved ? `metadata:\n  unresolved_requirements:\n${caveats.map(item => `    - ${item}`).join("\n")}\n` : ""}`;

async function serviceFor(fetcher: typeof fetch) {
  const repository = new Repository(null);
  const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
  registries.replaceReviewedTools([toolSchema.parse({ tool_id: "SYNTHETIC-DEPARTMENTS", name: "synthetic.departments", mcp_tool_name: "synthetic.departments", connection_id: "opaque-fixture", description: "Local synthetic QA departments read", is_read_only: true, allowed_roles: ["Platform Admin"], input_schema: { type: "object", properties: {}, additionalProperties: false }, bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [], output_schema: { type: "object", properties: { data: { type: "array", items: { type: "object" } } }, required: ["data"] } } })]);
  const validator = new RegistryValidator(registries, repository);
  const provider = new ProviderRuntime(repository, new Executor(new ToolRegistry(), validator), fetcher);
  provider.activate({ id: "fixture", name: "Fixture", type: "openai_compatible", baseURL: "https://fixture.invalid/v1", apiKey: "synthetic-only", model: "fixture-model", temperature: 0, timeoutMs: 1000,
    egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://fixture.invalid", runtimeAnalysisDataClasses: [], interactiveDataClasses: ["restricted"], reviewedAt: "2026-10-12T00:00:00Z", reviewedBy: { id: "test", name: "Test" } } });
  return { repository, service: new SynthesisService(provider, registries, validator) };
}

test("active v21 generation preserves historical requested-versus-context contracts", () => {
  expect(CANDIDATE_PROMPT_VERSION).toBe("prompt/candidate/v25");
  expect(createHash("sha256").update(systemInstructionsFor("prompt/candidate/v18")).digest("hex"))
    .toBe("d1a47db8c7fb1cb4a9bdae5be32ab00226a2e8adc867b372a9d3955107480c81");
  expect(createHash("sha256").update(systemInstructionsFor("prompt/candidate/v19")).digest("hex"))
    .toBe("14cc84fe622fac68946cba8f9f3243f121188acfcab2ae693db15935974b1a9b");
  const current = systemInstructionsFor("prompt/candidate/v20");
  expect(current).toContain("REQUESTED REQUIREMENTS VERSUS CONTEXT (mandatory)");
  expect(current).toContain("flat raw read with valid declared inputs and no requested field mapping");
  expect(current).toContain("genuinely unmet requested outcomes");
  expect(current).toContain("prompt/candidate/v20");
  expect(generationPromptHash("same request", "prompt/candidate/v20")).not.toBe(generationPromptHash("same request", "prompt/candidate/v19"));
});

test("opaque flat read keeps the exact proposal while context caveats do not become false blockers", async () => {
  const blocked = caveatYaml("Local synthetic QA lookup; not production. The source does not declare department fields.", true);
  const contextOnly = caveatYaml("Local synthetic QA lookup; not production. The source does not declare department fields.", false);
  let reply = blocked;
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: reply } }] }));
  const { service, repository } = await serviceFor(fetcher);

  const originallyBlocked = await service.synthesize({ prompt: "Read the offered departments capability as a local QA sample", userRole: "Platform Admin" });
  expect(originallyBlocked.yaml).toBe(blocked.trim());
  expect(originallyBlocked.validation.failed_rules).toContain("UNRESOLVED_REQUIREMENTS");
  expect(fetcher).toHaveBeenCalledTimes(1);

  reply = contextOnly;
  const flatRead = await service.synthesize({ prompt: "Read the offered departments capability as a local QA sample", userRole: "Platform Admin" });
  expect(flatRead.yaml).toBe(contextOnly.trim());
  expect(flatRead.validation.passed).toBe(true);
  expect(flatRead.candidate.generation_metadata.promptTemplateVersion).toBe("prompt/candidate/v25");
  expect(fetcher).toHaveBeenCalledTimes(2);
  const state = await repository.snapshot();
  expect(state.workflows).toEqual({});
  expect(state.executions).toEqual({});
});
