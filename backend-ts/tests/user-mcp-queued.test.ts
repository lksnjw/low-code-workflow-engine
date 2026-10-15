import { afterEach, expect, test, vi } from "vitest";
import { protectedPreparationFixture } from "./fixtures/protected-preparation.js";
import { UserMcpCredentials } from "../src/tools/user-mcp-credentials.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { admissionAuthorizer } from "../src/registry/capability-admission.js";
import { publishProtectedOperation } from "../src/workflows/protected-operation-publication.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { admitProtectedOperation } from "../src/runner/protected-job-admission.js";
import { runProtectedOperation } from "../src/runner/protected-job-worker.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
test.each(["current", "rotated", "missing"])("queued protected workflow preserves the original user's credential: %s", async scenario => {
  const s = await protectedPreparationFixture();
  s.config.erpbridgeConnections = [{ id: "erpbridge-default", baseURL: "https://synthetic.example.test", mcpToken: "private-synthetic-token", tokenReference: "TEST", roleMap: { "Platform Admin": "admin" }, primary: true }];
  const personalCalls: { token: string; args: Record<string, unknown> }[] = [];
  const credentials = new UserMcpCredentials(s.repository, s.config, options => ({
    metadataComplete: true, connect: async () => {}, close: async () => {}, listTools: async () => [],
    callTool: async (_name, args) => { personalCalls.push({ token: options.token, args }); return { content: [], structuredContent: { text: String(args.id) } }; },
  }));
  const session = await createErpbridgeMcpSession({ baseURL: "https://synthetic.example.test", token: "private-synthetic-token", timeoutMs: 1000,
    validator: s.services.validator, sdkClient: s.sdk, admissionAuthorizer: admissionAuthorizer(s.repository, s.registries), userMcpCredentials: credentials });
  cleanup.push(async () => { credentials.close(); await session.close(); await s.close(); });
  s.services.userMcpCredentials = credentials; s.services.erpbridgeSession = session;
  if (scenario !== "missing") await credentials.save(s.actor.id, "erpbridge-default", { baseRevision: 0, token: "REQUESTER-ORIGINAL-TEST-TOKEN" });
  const base = await s.repository.readAuthoritative(state => ({ baseVersion: state.workflows.flow!.draftVersion, baseHash: workflowContentHash(state.workflows.flow!.yaml) }));
  await publishProtectedOperation(s.services, "flow", s.actor, base);
  const admission = await admitProtectedOperation(s.services, "flow", s.actor, { items: ["one"] }, "personal-credential-queue-test-key");
  const id = String(admission.execution.id);
  const stored = await s.repository.readAuthoritative(state => state.executions[id]!.erpCredentialSecret);
  expect(stored).toMatchObject({ actorId: s.actor.id, revisions: { "erpbridge-default": scenario === "missing" ? 0 : 1 } });
  expect(admission.execution).not.toHaveProperty("erpCredentialSecret");
  if (scenario === "rotated") await credentials.save(s.actor.id, "erpbridge-default", { baseRevision: 1, token: "REQUESTER-REPLACEMENT-TEST-TOKEN" });
  const result = await runProtectedOperation(s.services, id);
  expect(s.sdk.callTool).not.toHaveBeenCalled();
  if (scenario === "current") {
    expect(result.status).toBe("DONE");
    expect(personalCalls).toHaveLength(2);
    expect(personalCalls.every(call => call.token === "REQUESTER-ORIGINAL-TEST-TOKEN")).toBe(true);
  } else {
    expect(result.status).toBe("FAILED"); expect(personalCalls).toHaveLength(0);
    expect(result.stepOutputs).toEqual({});
  }
});

test.each(["current", "rotated", "disabled"])("queued admin workflow keeps its exact server credential receipt: %s", async scenario => {
  const s = await protectedPreparationFixture();
  s.config.erpbridgeAdminEnvironmentAccess = true;
  s.config.erpbridgeConnections = [{ id: "erpbridge-default", baseURL: "https://synthetic.example.test", mcpToken: "private-synthetic-token", tokenReference: "TEST", roleMap: { "Platform Admin": "admin" }, primary: true }];
  const calls: string[] = [];
  const credentials = new UserMcpCredentials(s.repository, s.config, options => ({
    metadataComplete: true, connect: async () => {}, close: async () => {}, listTools: async () => [],
    callTool: async (_name, args) => { calls.push(options.token); return { content: [], structuredContent: { text: String(args.id) } }; },
  }));
  const session = await createErpbridgeMcpSession({ baseURL: "https://synthetic.example.test", token: "private-synthetic-token", timeoutMs: 1000,
    validator: s.services.validator, sdkClient: s.sdk, admissionAuthorizer: admissionAuthorizer(s.repository, s.registries), userMcpCredentials: credentials });
  cleanup.push(async () => { credentials.close(); await session.close(); await s.close(); });
  s.services.userMcpCredentials = credentials; s.services.erpbridgeSession = session;
  const base = await s.repository.readAuthoritative(state => ({ baseVersion: state.workflows.flow!.draftVersion, baseHash: workflowContentHash(state.workflows.flow!.yaml) }));
  await publishProtectedOperation(s.services, "flow", s.actor, base);
  const admission = await admitProtectedOperation(s.services, "flow", s.actor, { items: ["one"] }, "admin-environment-queue-test-key");
  const id = String(admission.execution.id);
  const stored = await s.repository.readAuthoritative(state => state.executions[id]!.erpCredentialSecret);
  expect(stored).toMatchObject({ actorId: s.actor.id, revisions: { "erpbridge-default": 0 }, environmentSecret: { "erpbridge-default": expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(admission.execution).not.toHaveProperty("erpCredentialSecret");
  if (scenario === "rotated") s.config.erpbridgeConnections[0]!.mcpToken = "ADMIN-ENV-REPLACEMENT-TEST-TOKEN";
  if (scenario === "disabled") s.config.erpbridgeAdminEnvironmentAccess = false;
  const result = await runProtectedOperation(s.services, id);
  expect(s.sdk.callTool).not.toHaveBeenCalled();
  if (scenario === "current") { expect(result.status).toBe("DONE"); expect(calls).toEqual(["private-synthetic-token", "private-synthetic-token"]); }
  else { expect(result.status).toBe("FAILED"); expect(calls).toHaveLength(0); expect(result.stepOutputs).toEqual({}); }
});
