import { describe, expect, test, vi } from "vitest";
import { checkErpPolicy, interpretPolicyResponse } from "../src/governance/rbac.js";

const params = { userId: "user", userRole: "Client", action: "payment.send", context: { amount: 10 } };
describe("required ERP policy decision", () => {
  test("missing service and failed request deny execution", async () => {
    expect((await checkErpPolicy(undefined, params)).allowed).toBe(false);
    expect((await checkErpPolicy({ callToolDirect: async () => { throw new Error("secret network error"); } }, params)).allowed).toBe(false);
  });
  test.each([null, [], {}, "allow", { allowed: "false" }, { allowed: 1 }, { result: "unknown" }, { decision: "conditional", conditions: ["manager approval"] }, { recommended_decision: "allow" }])("rejects malformed, advisory, or conditional decision %j", async (response) => {
    expect((await checkErpPolicy({ callToolDirect: async () => response }, params)).allowed).toBe(false);
  });
  test.each([{ allowed: true }, { decision: "approved" }, { result: "allow" }])("accepts explicit authorization %j", async (response) => {
    const callToolDirect = vi.fn(async () => response);
    expect((await checkErpPolicy({ callToolDirect }, params)).allowed).toBe(true);
    expect(callToolDirect).toHaveBeenCalledWith("policy-gate-evaluate", expect.objectContaining({ actor: { user_id: "user", role: "Client" }, context: { amount: 10 } }));
  });
  test.each([
    { content: [{ type: "text", text: '{"allowed":true}' }] },
    { content: [], structuredContent: { decision: "approved" } },
    { content: [{ type: "text", text: "Approved operation" }], structuredContent: { allowed: true } },
    { content: [{ type: "text", text: '{"allowed":true}' }], structuredContent: { allowed: true }, isError: false },
  ])("accepts explicit decisions inside MCP envelopes %j", async (response) => {
    expect((await checkErpPolicy({ callToolDirect: async () => response }, params)).allowed).toBe(true);
  });
  test.each([
    { allowed: true, decision: "denied" },
    { allowed: true, conditions: ["manager approval"] },
    { content: [], allowed: true },
    { content: [], structuredContent: { allowed: true }, isError: true },
    { content: [{ type: "text", text: '{"allowed":false}' }], structuredContent: { allowed: true } },
    { content: [{ type: "text", text: '{"allowed":true}' }, { type: "text", text: '{"allowed":false}' }] },
    { content: [{ type: "text", text: "allow" }] },
    { content: [{ type: "image", text: '{"allowed":true}' }] },
    { content: [], structuredContent: { content: [], structuredContent: { allowed: true } } },
    { content: [], structuredContent: { allowed: true }, isError: "false" },
  ])("rejects ambiguous, failed or invalid MCP authority %j", async (response) => {
    expect((await checkErpPolicy({ callToolDirect: async () => response }, params)).allowed).toBe(false);
  });
});

describe("research RAG decisions through ERPBridge", () => {
  test.each(["review", "allow_with_conditions", "conditional"])("%s remains non-executable review", async decision => {
    const raw = { decision, reason: "Independent evidence is still required", conditions: [{ field: "matched", satisfied: null }] };
    expect(interpretPolicyResponse({ content: [{ type: "text", text: JSON.stringify(raw) }], structuredContent: raw }))
      .toMatchObject({ allowed: false, decision: "review", reason: raw.reason });
    expect((await checkErpPolicy({ callToolDirect: async () => raw }, params)).allowed).toBe(false);
  });
  test("an allow with conditions never becomes execution permission, even if marked satisfied", () => {
    expect(interpretPolicyResponse({ decision: "allow", conditions: [{ satisfied: true }] })).toMatchObject({ allowed: false, decision: "review" });
  });
  test("deny stays deny when conditions are also present", () => {
    expect(interpretPolicyResponse({ decision: "deny", reason: "Blocked by policy", conditions: [{ satisfied: null }] }))
      .toMatchObject({ allowed: false, decision: "deny", reason: "Blocked by policy" });
  });
  test.each([
    { decision: "answer", request_type: "question" },
    { decision: "allow", request_type: "question" },
    { decision: "allow", conditions: "approved" },
    { decision: "review", allowed: true },
    { content: [{ type: "text", text: '{"decision":"deny"}' }], structuredContent: { decision: "review" } },
    { content: [{ type: "text", text: '{"decision":"answer"}' }], structuredContent: { decision: "allow" } },
  ])("non-action, malformed and contradictory decisions fail closed: %j", raw => {
    expect(interpretPolicyResponse(raw)).toMatchObject({ allowed: false, decision: "deny" });
  });
});
