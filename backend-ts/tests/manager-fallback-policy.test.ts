import { readFile } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import { LlmPolicyFallback, fallbackPolicySchema } from "../src/governance/llm-fallback.js";
const policyPath = new URL("../policy/governance_fallback.json", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const fallback = new LlmPolicyFallback({ policyPath: decodeURI(policyPath), openrouterApiKey: "", model: "", timeoutMs: 1000 });
const request = (role: string, proposedActions: string[]) => ({ requestId: "qa", user: { id: "manager", role, department: null }, intent: "PublishWorkflow", proposedActions, caseContext: {} });
describe("Manager reviewed offline read pack", () => {
  it("allows only the exact configured reads while retaining write and unknown-role denial", async () => {
    const policy = fallbackPolicySchema.parse(JSON.parse(await readFile(new URL("../policy/governance_fallback.json", import.meta.url), "utf8")));
    const actions = policy.role_access.Manager!.allowed_tools!;
    expect(actions).toHaveLength(19);
    expect((await fallback.evaluate(request("Manager", actions), true)).allowed).toBe(true);
    expect((await fallback.evaluate(request("Manager", actions), false)).allowed).toBe(false);
    expect((await fallback.evaluate(request("Manager", [...actions, "list_employees"]), true)).allowed).toBe(false);
    expect((await fallback.evaluate(request("Manager", ["resend-email-send"]), false)).allowed).toBe(false);
    expect((await fallback.evaluate(request("Unconfigured role", actions), true)).allowed).toBe(false);
  });
  it("still enforces global human-review rules ahead of role allowance", async () => {
    const result = await fallback.evaluate(request("Manager", ["delete_customer"]), true);
    expect(result.allowed).toBe(false); expect(result.reason).toContain("human review");
  });
});
