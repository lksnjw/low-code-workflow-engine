import { afterEach, expect, test, vi } from "vitest";
import jwt from "jsonwebtoken";
import { boundedChatFixture } from "./fixtures/bounded-chat-task.js";
import { handleFunctionProgress, isFunctionProgressRequest } from "../src/firebase/progress-http.js";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(closers.splice(0).map(close => close())); });
async function setup() {
  const f = await boundedChatFixture(); closers.push(f.close);
  const config = { ...f.services.config, storageDriver: "firestore-records" as const,
    pipelineAPIBaseURL: "https://pipeline.example.test", pipelineAPIKey: "fixture-pipeline-key", pipelineWorkspaceId: "fixture" };
  const open = vi.fn(() => ({ snapshot: async () => f.repository.snapshot(), close: async () => {} }));
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ items: [{ id: "upload", filename: "form.png", text: "private source", file_base64: "private bytes" }] }));
  vi.stubGlobal("fetch", fetcher);
  const get = (url: string, headers = f.headers) => handleFunctionProgress(config, { method: "GET", url, headers }, open);
  return { ...f, config, get, fetcher, open };
}

test("catalog, inventory and owned attachment lists use read-only scoped transport without writer or model work", async () => {
  const f = await setup(), before = await f.repository.snapshot();
  for (const path of ["/api/pipeline/v1/library/catalog", "/api/pipeline/v1/library/inventory", `/api/chat/sessions/${f.sessionId}/attachments`]) {
    expect(isFunctionProgressRequest(f.config, { method: "GET", url: path, headers: f.headers })).toBe(true);
    const result = await f.get(path); expect(result.statusCode).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    if (path.endsWith("/attachments")) expect(JSON.parse(result.body.toString())).toEqual({ items: [{ id: "upload", filename: "form.png" }] });
  }
  for (const [url, init] of f.fetcher.mock.calls) {
    expect(String(url)).toMatch(/^https:\/\/pipeline\.example\.test\/v1\/library\/(catalog|inventory|uploads)/);
    expect(init?.method).toBe("GET");
    const headers = init!.headers as Record<string, string>;
    const scope = JSON.parse(Buffer.from(headers["X-Library-Scope"]!.split(".")[0]!, "base64url").toString());
    expect(scope).toMatchObject({ actorId: "owner", readOnly: true, canUpload: false, canManage: false });
  }
  expect(await f.repository.snapshot()).toEqual(before);
  expect(f.sdk.callTool).not.toHaveBeenCalled(); expect(f.fetchImplementation).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});

test("invalid token, revoked permission and another user's chat never reach the document pipeline", async () => {
  const f = await setup(), path = `/api/chat/sessions/${f.sessionId}/attachments`;
  expect((await f.get(path, { authorization: "Bearer invalid" })).statusCode).toBe(401);
  expect(f.open).not.toHaveBeenCalled();
  await f.repository.mutate(state => { state.users.other = { ...state.users.owner!, id: "other" }; });
  const other = { authorization: `Bearer ${jwt.sign({}, f.config.jwtSecret, { subject: "other" })}` };
  expect((await f.get(path, other)).statusCode).toBe(404);
  await f.repository.mutate(state => { state.roles.role_admin!.permissions = ["chat:use"]; });
  expect((await f.get(path)).statusCode).toBe(403);
  expect(f.fetcher).not.toHaveBeenCalled();
});

test("document access is rechecked after the network response, and mutation routes never use the read lane", async () => {
  const f = await setup(), path = `/api/chat/sessions/${f.sessionId}/attachments`;
  f.fetcher.mockImplementationOnce(async () => {
    await f.repository.mutate(state => { state.chats[f.sessionId]!.ownerId = "other"; });
    return Response.json({ items: [{ id: "private-upload" }] });
  });
  const result = await f.get(path); expect(result.statusCode).toBe(404); expect(result.body.toString()).not.toContain("private-upload");
  for (const url of [path, "/api/pipeline/v1/library/catalog", "/api/pipeline/v1/library/migrate", `${path}/preview`, `${path}/upload/confirm`])
    expect(isFunctionProgressRequest(f.config, { method: "POST", url, headers: f.headers })).toBe(false);
  expect(isFunctionProgressRequest(f.config, { method: "GET", url: `${path}/upload/source`, headers: f.headers })).toBe(false);
  expect((await f.get(`${path}?actorId=other`)).statusCode).toBe(400);
});

test("opening an attachment returns its owned source text using a read-only scope and verifies the chat association", async () => {
  const f = await setup(), path = `/api/chat/sessions/${f.sessionId}/attachments/upload`;
  f.fetcher.mockResolvedValueOnce(Response.json({ id: "upload", session_id: f.sessionId, extracted_text: "Reviewed source", file_base64: "private file" }));
  const result = await f.get(path); expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body.toString())).toEqual({ id: "upload", session_id: f.sessionId, extracted_text: "Reviewed source" });
  const [url, init] = f.fetcher.mock.calls[0]!;
  expect(String(url)).toBe("https://pipeline.example.test/v1/library/uploads/upload?include_text=true");
  const scope = JSON.parse(Buffer.from((init!.headers as Record<string, string>)["X-Library-Scope"]!.split(".")[0]!, "base64url").toString());
  expect(scope.readOnly).toBe(true);
  f.fetcher.mockResolvedValueOnce(Response.json({ id: "upload", session_id: "other-chat", extracted_text: "Do not disclose" }));
  const wrong = await f.get(path); expect(wrong.statusCode).toBe(404); expect(wrong.body.toString()).not.toContain("Do not disclose");
});
