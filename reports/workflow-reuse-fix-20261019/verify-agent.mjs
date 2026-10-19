import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { deployedQaClient } from "../../ops/deployment/firebase/deployed-qa-client.mjs";
const qa = await deployedQaClient();
const report = { startedAt: new Date().toISOString(), status: "RUNNING", erpWrites: 0, operations: [] };
const save = () => writeFile(new URL("agent-verification.json", import.meta.url), JSON.stringify(report, null, 2));
try {
  const chat = (await qa.request("/chat/sessions", "POST", { title: "Reusable customer workflow authoring verification", idempotencyKey: randomUUID() }, 201)).data;
  report.chatId = chat.id; await save();
  const content = 'Create and save a reusable workflow called "Customer Registration OCR Release Check". Each run handles one new ERP customer from new image/PDF run inputs or manual inputs. Require customer_name, customer_type (Company or Individual), customer_group and territory in trigger.config.inputSchema, then bind those per-run values. Use the current available get_customer_group and get_territory tools to verify references, followed by the exact create_customer tool. Keep backend human approval before creation and policy checks. Select the exact current tool names and required parameters from your full live catalog. Do not invent an OCR step or approval tool. Multiple files are reviewed in the Run dialog; the user chooses one record per run. Do not publish, run, send or change any ERP record. If no exact duplicate-check tool is suitable, state that limitation instead of inventing a check.';
  const receipt = (await qa.request(`/chat/sessions/${chat.id}/messages`, "POST", { content, delivery: "async-chat", idempotencyKey: randomUUID() }, 202)).data;
  report.operationId = receipt.operation.id; await save();
  let frame, cursor = 0;
  const deadline = Date.now() + 240000;
  do {
    frame = (await qa.request(`/chat/operations/${receipt.operation.id}?after=${cursor}&waitMs=10000`)).data;
    cursor = frame.nextCursor; report.operation = frame.operation; await save();
    if (!["QUEUED", "RUNNING"].includes(frame.operation.status)) break;
  } while (Date.now() < deadline);
  assert.equal(frame.operation.status, "ANSWERED");
  const saved = (await qa.request(`/chat/sessions/${chat.id}?limit=20`)).data;
  const answer = saved.messages.find(message => message.id === frame.operation.assistantMessageId);
  assert(answer); report.answer = { text: answer.text, artifacts: answer.artifacts };
  assert(answer.artifacts?.workflowId || answer.artifacts?.workflowDraft);
  assert(!answer.artifacts?.erpActionProposals?.length);
  report.status = "PASSED";
} catch (error) { report.status = "FAILED"; report.reason = String(error.message).slice(0, 1000); process.exitCode = 1; }
finally { await qa.close(); await save(); console.log(JSON.stringify({ status: report.status, chatId: report.chatId, operationId: report.operationId, erpWrites: 0, reason: report.reason })); }
