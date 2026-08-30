import { describe, expect, test } from "vitest";
import {
  compressFirestorePayload,
  decompressFirestorePayload,
} from "../src/storage/firestore.js";

describe("Firestore state compression", () => {
  test("round-trips repository JSON and substantially reduces repetitive chat artifacts", () => {
    const payload = Buffer.from(JSON.stringify({
      chats: Array.from({ length: 40 }, (_, index) => ({
        id: `chat_${index}`,
        messages: Array.from({ length: 8 }, () => ({
          role: "assistant",
          text: "Generated workflow passed validation.",
          artifacts: {
            selected_workflow_yaml: "name: Example\ntrigger:\n  type: manual\nsteps: []",
            retrieval: { tools: [{ name: "erp.list_warehouses", description: "List ERP warehouses" }] },
          },
        })),
      })),
    }), "utf8");

    const compressed = compressFirestorePayload(payload);

    expect(compressed.byteLength).toBeLessThan(payload.byteLength / 4);
    expect(Buffer.from(decompressFirestorePayload(compressed)).equals(payload)).toBe(true);
  });
});
