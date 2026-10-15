import { expect, test, vi } from "vitest";
import { OpenAICompatibleClient, generationRequestBody, interactiveQueryReasoningProfile } from "../src/providers/openai-compatible.js";
const baseURL = "https://openrouter.ai/api/v1", model = "google/gemini-3.8-flash";
const interactive = { egress: { purpose: "interactive" as const, dataClass: "restricted" as const } };

test.each(["prompt/intent-routing/v3", "prompt/intent-routing/v4", "prompt/erp-chat/v3", "prompt/erp-chat/v4"])("Gemini %s uses supported low effort, not disabled mandatory reasoning", async promptTemplateVersion => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init?.body));
    expect(wire.reasoning).toEqual({ effort: "low" }); expect(wire.max_tokens).toBe(900); expect(wire.model).toBe(model);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "Confirmed answer" } }] });
  });
  const client = new OpenAICompatibleClient({ baseURL, apiKey: "fixture", model, fetchImplementation: fetcher });
  expect((await client.queryWithTools([{ role: "user", content: "Clarify" }], [], { promptTemplateVersion, maxOutputTokens: 900, context: interactive })).completionConfirmed).toBe(true);
  expect(interactiveQueryReasoningProfile(baseURL, model, { promptTemplateVersion, context: interactive })).toBe("openrouter-gemini-bounded-low/v1");
});

test("Gemini whole-workflow proposals keep bounded supported reasoning without changing historical modifier behavior", () => {
  expect(generationRequestBody(baseURL, model, 0, "edit", { ...interactive, promptTemplateVersion: "prompt/workflow-modifier/v4" })).toMatchObject({ reasoning: { effort: "low" } });
  expect(generationRequestBody(baseURL, model, 0, "edit", { ...interactive, promptTemplateVersion: "prompt/workflow-modifier/v2" })).not.toHaveProperty("reasoning");
});

test("Gemini local policy retains a strict JSON response within its bounded budget", () => {
  expect(generationRequestBody(baseURL, model, 0, "policy", { ...interactive, promptTemplateVersion: "prompt/local-policy/v2", maxOutputTokens: 1024 })).toMatchObject({
    max_tokens: 1024, reasoning: { effort: "low" }, response_format: { type: "json_object" },
  });
});

test.each(["prompt/intent-routing/v2", "prompt/erp-chat/v2", "prompt/query/v6", "prompt/runtime-agent/v1"])("historical/unselected Gemini %s is not silently changed", promptTemplateVersion => {
  expect(interactiveQueryReasoningProfile(baseURL, model, { promptTemplateVersion, context: interactive })).toBeUndefined();
});

test("runtime models, unapproved endpoints and unrelated generations do not inherit the interactive policy profile", () => {
  expect(generationRequestBody(baseURL, model, 0, "runtime", { promptTemplateVersion: "prompt/local-policy/v2", egress: { purpose: "runtime_analysis", dataClass: "internal" } })).not.toHaveProperty("reasoning");
  expect(generationRequestBody("https://other.example.test/v1", model, 0, "policy", { ...interactive, promptTemplateVersion: "prompt/local-policy/v2" })).not.toHaveProperty("reasoning");
  expect(generationRequestBody(baseURL, model, 0, "document", { ...interactive, promptTemplateVersion: "prompt/document-preview/v1" })).not.toHaveProperty("reasoning");
});
