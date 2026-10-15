import { expect, test, vi } from "vitest";
const fixture = vi.hoisted(() => ({ read: vi.fn(), mutate: vi.fn(), executeTask: vi.fn(), runtime: vi.fn() }));
vi.mock("../src/firebase/state-phases.js", () => ({ functionStatePhases: () => ({ read: fixture.read, mutate: fixture.mutate }) }));
vi.mock("../src/firebase/invocation.js", () => ({ withFunctionResources: vi.fn(), withFunctionRuntime: fixture.runtime }));
vi.mock("../src/agent/chat-jobs.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/agent/chat-jobs.js")>(), chatJobQueue: () => ({ executeTask: fixture.executeTask }) }));
import { executeFunctionChatTask } from "../src/firebase/chat-task.js";
import { loadConfig } from "../src/config/config.js";
import { chatTaskCommandSchema } from "../src/agent/chat-task-outbox.js";

test.each(["QUERY", "ACTION", "WORKFLOW_MODIFY", "CONVERSATION"])("Functions agent routing does not bypass semantic intent using the initial %s heuristic", async intent => {
  const command = chatTaskCommandSchema.parse({ profile: "chat-task-delivery/v1", taskId: `chat-${"a".repeat(64)}`, operationId: "operation-original" });
  const services = { marker: "fresh owned runtime" };
  fixture.read.mockResolvedValueOnce({ input: { user: { id: "original-requester" }, content: "ambiguous request", body: {}, provider: { model: "selected-model" } }, intent });
  fixture.runtime.mockImplementationOnce(async (_composition, callback) => callback({ services }));
  fixture.executeTask.mockResolvedValueOnce({ status: "ANSWERED" });
  const options = { timeoutMs: 20000 };
  const composition: any = { config: loadConfig({ APP_ENV: "test", CHAT_INTENT_ROUTING: "agent" }), root: process.cwd() };
  expect(await executeFunctionChatTask(composition, command, options)).toEqual({ status: "ANSWERED" });
  expect(fixture.runtime).toHaveBeenLastCalledWith(composition, expect.any(Function));
  expect(fixture.executeTask).toHaveBeenLastCalledWith(command, options);
  expect(fixture.mutate).not.toHaveBeenCalled();
});

test("reviewed document drafting uses the source-admitting worker even when legacy routing is configured", async () => {
  const command = chatTaskCommandSchema.parse({ profile: "chat-task-delivery/v1", taskId: `chat-${"b".repeat(64)}`, operationId: "document-operation" });
  fixture.read.mockResolvedValueOnce({ input: { user: { id: "original-requester" }, content: "Create a customer workflow", body: {
    documentContext: { uploadId: "upload", documentId: "document", version: 1, purpose: "erp_record_proposal" },
  }, provider: { model: "selected-model" } }, intent: "ACTION" });
  fixture.runtime.mockImplementationOnce(async (_composition, callback) => callback({ services: { marker: "owned worker" } }));
  fixture.executeTask.mockResolvedValueOnce({ status: "ANSWERED" });
  const options = { timeoutMs: 20000 };
  const composition: any = { config: { ...loadConfig({ APP_ENV: "test" }), chatIntentRouting: "pattern" }, root: process.cwd() };
  expect(await executeFunctionChatTask(composition, command, options)).toEqual({ status: "ANSWERED" });
  expect(fixture.executeTask).toHaveBeenLastCalledWith(command, options);
  expect(fixture.mutate).not.toHaveBeenCalled();
});
