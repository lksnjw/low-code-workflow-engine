import { afterEach, expect, test, vi } from "vitest";
import { HandlerFailure } from "../src/http/handlers/common.js";
import { userMcpFailureCode } from "../src/tools/user-mcp-failure.js";
import { readFailureReason } from "../src/runner/read-failure-reason.js";
import { runQueryLoop } from "../src/agent/query-loop.js";
import { toolSchema } from "../src/registry/schemas.js";

afterEach(() => vi.unstubAllEnvs());
test("credential diagnostics accept only local typed failures, not remote text/JSON", () => {
  const local = new HandlerFailure(409, "private diagnostic", { code: "ERP_USER_CREDENTIAL_REQUIRED" });
  expect(readFailureReason(local)).toBe("ERP_USER_CREDENTIAL_REQUIRED");
  expect(userMcpFailureCode(new Error("ERP_USER_CREDENTIAL_REQUIRED"))).toBeUndefined();
  expect(userMcpFailureCode({ meta: { code: "ERP_USER_CREDENTIAL_REQUIRED" } })).toBeUndefined();
});
test.each(["pi", "legacy"])("%s chat explains a missing personal token without inventing data or granting retry authority", async runtime => {
  vi.stubEnv("LCWE_AGENT_RUNTIME", runtime);
  const read = toolSchema.parse({ tool_id: "test-read", name: "company.list", mcp_tool_name: "company.list", description: "Read companies",
    is_read_only: true, allowed_roles: ["Workflow Builder"], input_schema: { type: "object", properties: {}, additionalProperties: false } });
  const queryWithTools = vi.fn(async () => ({ text: "", toolCalls: [{ id: "read", name: "company.list", arguments: {} }], stopReason: "tool_calls", inputTokens: 5, outputTokens: 5 }));
  const dispatch = vi.fn(async () => { throw new HandlerFailure(409, "internal-only-diagnostic", { code: "ERP_USER_CREDENTIAL_REQUIRED" }); });
  const result = await runQueryLoop({ userMessage: "Show companies", chatHistory: [], sessionId: "test-chat", actorId: "alice", actorRole: "Workflow Builder" }, [read], dispatch, { queryWithTools });
  expect(result.text).toContain("Profile → My ERP connections");
  expect(result.text).toContain("No ERP data was retrieved.");
  expect(result.text).not.toContain("internal-only-diagnostic");
  expect(result).toMatchObject({ readOutcome: "NO_CONFIRMED_READ", narrativeRejected: true });
  expect(result.recoveryGuidance).toBeUndefined(); expect(result.visualisation).toBeUndefined();
  expect(dispatch).toHaveBeenCalledOnce(); expect(queryWithTools).toHaveBeenCalledOnce();
});
