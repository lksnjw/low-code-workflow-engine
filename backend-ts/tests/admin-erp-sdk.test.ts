import { resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { Repository } from "../src/repository/store.js";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
const tool = { name: "create_item", inputSchema: { type: "object", properties: { item_code: { type: "string" } }, required: ["item_code"], additionalProperties: false }, annotations: { readOnlyHint: false }, _meta: { "toolplane.resourceDigest": "a".repeat(64) } };
async function setup(enabled = true) {
 const repository = new Repository(null);
 await repository.mutate(state => { state.users.admin = { id: "admin", roleId: "role_admin", status: "Active", permissionOverrides: [] } as any; });
 const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
 const sdk = { connect: vi.fn(async () => {}), close: vi.fn(async () => {}), listTools: vi.fn(async () => [tool]), callTool: vi.fn(async () => ({ content: [], structuredContent: { name: "QA-1" } })) };
 const session = await createErpbridgeMcpSession({ baseURL: "https://bridge.example.test", token: "fixture", timeoutMs: 1000, validator: new RegistryValidator(registries, repository), sdkClient: sdk, administratorChatActions: enabled });
 return { repository, sdk, session };
}
test("administrator dispatch is absent by default and never changes the ordinary governed client", async () => {
 const s = await setup(false); expect(s.session.executeAdministratorTool).toBeUndefined(); await s.session.close();
});
test("administrator boundary validates before checkpoint, pins digest, and accepts actual response", async () => {
 const s = await setup(), checkpoint = vi.fn(async () => { expect(s.sdk.callTool).not.toHaveBeenCalled(); });
 expect(await s.session.executeAdministratorTool!(tool, { item_code: "QA-1" }, "admin", checkpoint)).toMatchObject({ structuredContent: { name: "QA-1" } });
 expect(s.sdk.callTool).toHaveBeenCalledWith("create_item", { item_code: "QA-1" }, { "toolplane.resourceDigest": "a".repeat(64) }); expect(checkpoint).toHaveBeenCalledOnce(); await s.session.close();
});
test.each(["missing", "wrong-type", "contract-drift", "role", "closed"])("%s blocks before dispatch intent and SDK entry", async kind => {
 const s = await setup(), checkpoint = vi.fn(async () => {});
 if (kind === "contract-drift") s.sdk.listTools.mockResolvedValueOnce([{ ...tool, description: "Changed" }] as any);
 if (kind === "role") await s.repository.mutate(state => { state.users.admin!.roleId = "role_client"; });
 if (kind === "closed") await s.session.close();
 await expect(s.session.executeAdministratorTool!(tool, kind === "missing" ? {} : kind === "wrong-type" ? { item_code: ["QA-1"] } : { item_code: "QA-1" }, "admin", checkpoint)).rejects.toBeDefined();
 expect(checkpoint).not.toHaveBeenCalled(); expect(s.sdk.callTool).not.toHaveBeenCalled(); await s.session.close();
});
test.each([false, true])("only an exact raw not_found marker may identify absence (extra metadata=%s)", async extra => {
 const s = await setup();
 const lookup = { ...tool, name: "get_item", annotations: { readOnlyHint: true } };
 s.sdk.listTools.mockResolvedValue([lookup] as any);
 s.sdk.callTool.mockResolvedValue({ content: [], isError: true, _meta: { "com.erpbridge/error": { type: "not_found", retryable: false, ...(extra ? { injected: true } : {}) } } } as any);
 const result = await s.session.executeAdministratorTool!(lookup, { item_code: "QA-1" }, "admin", async () => {});
 expect(result.readBusinessOutcome).toBe(extra ? undefined : "NOT_FOUND"); await s.session.close();
});
