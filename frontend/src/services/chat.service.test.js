import { afterEach, expect, jest, test } from "@jest/globals";
import { apiClient } from "../config/axios";
import { chatService } from "./chat.service";

afterEach(() => jest.restoreAllMocks());

test("sendMessage no longer sends the previously ignored workflowId option", async () => {
  const post = jest.spyOn(apiClient, "post").mockResolvedValue({
    data: { data: { answer: "ok" } },
  });

  await chatService.sendMessage("chat-1", "hello", {
    mode: "guided",
    model: "test-model",
    workflowId: "wf-ignored",
  });

  expect(post).toHaveBeenCalledWith(
    "/chat/sessions/chat-1/messages",
    {
      content: "hello",
      mode: "guided",
      model: "test-model",
    },
    { timeout: 180000 },
  );
});
