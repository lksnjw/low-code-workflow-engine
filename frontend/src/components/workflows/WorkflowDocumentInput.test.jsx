/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { chatService } from "../../services/chat.service";
import { documentWorkspaceService as documents } from "../../services/document-workspace.service";
import WorkflowRunDialog from "./WorkflowRunDialog";
import { documentInputInstruction, documentInputProposal, mergeDocumentInputProposals } from "./workflowDocumentMapping";

const schema = { type: "object", additionalProperties: false, required: ["customer_name", "quantity"], properties: { customer_name: { type: "string" }, quantity: { type: "integer", minimum: 1 }, note: { type: "string" }, secret: { type: "string", writeOnly: true } } };
const ready = { name: "Register customer", publishedVersion: 1, can_attempt_run: true, authoring: { inputSchema: schema } };
const prepared = { attachment: { filename: "form.png", summary: "Customer registration", fields: { customer_name: "New Customer", quantity: 2 }, warnings: [], uploadId: "upload-one" }, upload: { status: "EXTRACTING" }, pipelineStorageConfirmed: true };
beforeEach(() => {
  jest.spyOn(chatService, "models").mockResolvedValue({ configured: true, models: ["deepseek/test"], binding: { model: "deepseek/test" } });
  jest.spyOn(chatService, "createSession").mockResolvedValue({ id: "source-chat" });
  jest.spyOn(documents, "prepare").mockResolvedValue(prepared);
  jest.spyOn(documents, "get").mockResolvedValue({ status: "REVIEW", extraction_state: "SUCCEEDED" });
});
afterEach(() => { cleanup(); jest.restoreAllMocks(); });
const mount = (props = {}) => render(<WorkflowRunDialog open workflowId="wf" initialRecord={ready} onClose={jest.fn()} onRun={jest.fn()} {...props} />);
const choose = async (name = "form.png") => {
  if (screen.queryByRole("button", { name: "Fill inputs from a document" })) fireEvent.click(screen.getByRole("button", { name: "Fill inputs from a document" }));
  await waitFor(() => expect(chatService.models).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("Workflow input document"), { target: { files: [new File(["source"], name, { type: "image/png" })] } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Read document" }).disabled).toBe(false));
};
const read = async () => { await choose(); fireEvent.click(screen.getByRole("button", { name: "Read document" })); await screen.findByText("Customer registration"); };

test("opening Run performs no document requests or ERP operation", () => {
  const onRun = jest.fn(); mount({ onRun });
  expect(chatService.models).not.toHaveBeenCalled(); expect(documents.prepare).not.toHaveBeenCalled(); expect(onRun).not.toHaveBeenCalled();
});

test("extraction model stays background-only and OCR status remains receipt-based", async () => {
  documents.prepare.mockResolvedValue({ ...prepared, attachment: { ...prepared.attachment, model: "google/gemini-3.8-flash", warnings: ["google/gemini-3.8-flash: model-only preview; OCR not confirmed"] } });
  mount(); await read();
  expect(screen.queryByRole("combobox", { name: "Run document model" })).toBeNull();
  expect(document.body.textContent).not.toMatch(/gemini|deepseek/i);
  expect(document.body.textContent).toContain("OCR is still processing");
  expect(screen.queryByText(/OCR completed/)).toBeNull();
  expect(documents.prepare).toHaveBeenCalledWith("source-chat", expect.any(File), expect.objectContaining({ model: "deepseek/test" }));
  fireEvent.click(screen.getByRole("button", { name: "Check OCR status" }));
  await screen.findByText(/OCR completed/);
  expect(screen.getByText(/Recorded during initial reading/)).toBeTruthy();
});
test("upload uses private source conversation and chosen model; review and exact explicit run remain required", async () => {
  const onRun = jest.fn().mockResolvedValue({ id: "run-one" }); mount({ onRun }); await read();
  expect(documents.prepare).toHaveBeenCalledWith("source-chat", expect.any(File), expect.objectContaining({ model: "deepseek/test", saveToConversation: true, idempotencyKey: expect.any(String) }));
  expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Use extracted values" }));
  expect(screen.getByLabelText("Customer name").value).toBe("New Customer");
  expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("I checked these inputs against the source document"));
  expect(onRun).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Start workflow" }));
  await waitFor(() => expect(onRun).toHaveBeenCalledWith({ customer_name: "New Customer", quantity: 2 }));
});
test("missing required field blocks review/run until supplied; editing resets source confirmation", async () => {
  documents.prepare.mockResolvedValue({ ...prepared, attachment: { ...prepared.attachment, fields: { quantity: 2 } } });
  mount(); await read(); fireEvent.click(screen.getByRole("button", { name: "Use extracted values" }));
  const checkbox = screen.getByLabelText("I checked these inputs against the source document"); expect(checkbox.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Customer name"), { target: { value: "Reviewed Name" } }); fireEvent.click(checkbox);
  expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "3" } }); expect(checkbox.checked).toBe(false);
});
test("different file and removal clear old document values, and OCR refresh does not replace reviewed inputs", async () => {
  mount(); await read(); fireEvent.click(screen.getByRole("button", { name: "Use extracted values" }));
  fireEvent.change(screen.getByLabelText("Customer name"), { target: { value: "Manually checked" } });
  fireEvent.click(screen.getByRole("button", { name: "Check OCR status" })); await screen.findByText(/OCR completed/);
  expect(screen.getByLabelText("Customer name").value).toBe("Manually checked");
  await choose("another.png"); expect(screen.getByLabelText("Customer name").value).toBe(""); expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Remove document" })); expect(screen.queryByRole("checkbox")).toBeNull();
});
test("pipeline outage is not called storage success; reviewed source inputs can be submitted for backend validation", async () => {
  documents.prepare.mockResolvedValue({ ...prepared, upload: undefined, pipelineStorageConfirmed: false, attachment: { ...prepared.attachment, uploadId: undefined } });
  mount({ initialRecord: { ...ready, can_attempt_run: false } }); await read();
  expect(screen.getByText(/Pipeline storage is not confirmed/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Use extracted values" })); fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(false);
});
test("batch extraction cannot silently choose one customer", async () => {
  documents.prepare.mockResolvedValue({ ...prepared, attachment: { ...prepared.attachment, rows: [{ customer_name: "A" }, { customer_name: "B" }] } });
  mount(); await read(); expect(screen.getByRole("button", { name: "Use extracted values" }).disabled).toBe(true); expect(screen.getByLabelText("Customer name").value).toBe("");
});
test("closing while preparation is pending never starts a workflow or updates another dialog", async () => {
  let finish; documents.prepare.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const onRun = jest.fn(), view = mount({ onRun }); await choose(); fireEvent.click(screen.getByRole("button", { name: "Read document" }));
  await waitFor(() => expect(documents.prepare).toHaveBeenCalled()); view.unmount(); await act(async () => finish(prepared)); expect(onRun).not.toHaveBeenCalled();
});
test("only exact declared scalar values survive; no secret, unknown, prototype, batch or coerced values", () => {
  expect(documentInputProposal(schema, { fields: { customer_name: "A", quantity: "2", secret: "credential", tool: "create_customer", unknown: 1 } }).values).toEqual({ customer_name: "A" });
  expect(documentInputProposal(schema, { rows: [{ customer_name: "A" }], fields: { customer_name: "A" } }).values).toEqual({});
  expect(documentInputInstruction(schema)).not.toContain('"secret"'); expect(documentInputInstruction(schema).length).toBeLessThanOrEqual(2000);
});
test("an explicit retry retains the original upload key and cannot duplicate an ERP run", async () => {
  const onRun = jest.fn(); documents.prepare.mockRejectedValueOnce(new Error("Upload acknowledgement unknown")).mockResolvedValue(prepared);
  mount({ onRun }); await choose(); fireEvent.click(screen.getByRole("button", { name: "Read document" }));
  await screen.findByText(/Upload acknowledgement unknown/);
  const first = documents.prepare.mock.calls[0]; expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Read document" })); await screen.findByText("Customer registration");
  expect(documents.prepare.mock.calls[1][2].idempotencyKey).toBe(first[2].idempotencyKey); expect(chatService.createSession).toHaveBeenCalledTimes(1); expect(onRun).not.toHaveBeenCalled();
});

test("a busy server gives recovery guidance without automatically resubmitting the upload", async () => {
  const onRun = jest.fn(); documents.prepare.mockRejectedValueOnce(Object.assign(new Error("Request failed with status code 503"), { status: 503 }));
  mount({ onRun }); await choose(); fireEvent.click(screen.getByRole("button", { name: "Read document" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("recover the same upload");
  expect(alert.textContent).toContain("enter the fields manually");
  expect(screen.getByRole("link", { name: "Open source conversation" }).getAttribute("href")).toBe("/chat/source-chat");
  expect(documents.prepare).toHaveBeenCalledTimes(1); expect(onRun).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(true);
});
test("unsupported file does not upload; large schemas keep the complete instruction within its bound", async () => {
  mount(); await choose(); fireEvent.change(screen.getByLabelText("Workflow input document"), { target: { files: [new File(["x"], "program.exe")] } });
  expect(screen.getByRole("alert").textContent).toContain("supported"); expect(documents.prepare).not.toHaveBeenCalled();
  const instruction = documentInputInstruction({ type: "object", properties: Object.fromEntries(Array.from({ length: 50 }, (_, i) => ["long_field_".repeat(6) + i, { type: "string" }])) });
  expect(instruction.length).toBeLessThanOrEqual(2000); expect(instruction).toContain("Other fields will be completed manually.");
});

const chooseMany = async (count = 2) => {
  fireEvent.click(screen.getByRole("button", { name: "Fill inputs from a document" }));
  await waitFor(() => expect(chatService.models).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("Workflow input document"), { target: { files: Array.from({ length: count }, (_, at) => new File([`page ${at}`], `page-${at}.png`, { type: "image/png" })) } });
};

test("multiple pages wait for every file, require same-record review, merge exact values and preserve per-file keys", async () => {
  const onRun = jest.fn();
  documents.prepare.mockResolvedValueOnce({ ...prepared, attachment: { ...prepared.attachment, fields: { customer_name: "New Customer" } } })
    .mockResolvedValueOnce({ ...prepared, attachment: { ...prepared.attachment, fields: { quantity: 2 } } });
  mount({ onRun }); await chooseMany(); fireEvent.click(screen.getByRole("button", { name: "Read documents" }));
  await screen.findByRole("button", { name: "Use extracted values" });
  expect(documents.prepare).toHaveBeenCalledTimes(2);
  expect(documents.prepare.mock.calls[0][2].idempotencyKey).not.toBe(documents.prepare.mock.calls[1][2].idempotencyKey);
  expect(screen.getByRole("button", { name: "Use extracted values" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "These files all belong to the same record." }));
  fireEvent.click(screen.getByRole("button", { name: "Use extracted values" }));
  expect(screen.getByLabelText("Customer name").value).toBe("New Customer");
  expect(screen.getByLabelText("Quantity").value).toBe("2");
  expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(true);
  expect(onRun).not.toHaveBeenCalled();
});

test("a partial multiple-file failure recovers only the unfinished original upload", async () => {
  documents.prepare.mockResolvedValueOnce(prepared).mockRejectedValueOnce(new Error("Second file unavailable")).mockResolvedValueOnce(prepared);
  mount(); await chooseMany(); fireEvent.click(screen.getByRole("button", { name: "Read documents" }));
  await screen.findByText(/Second file unavailable/);
  expect(screen.queryByRole("button", { name: "Use extracted values" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Read documents" }));
  await screen.findByRole("button", { name: "Use extracted values" });
  expect(documents.prepare).toHaveBeenCalledTimes(3);
  expect(documents.prepare.mock.calls[2][2].idempotencyKey).toBe(documents.prepare.mock.calls[1][2].idempotencyKey);
  expect(chatService.createSession).toHaveBeenCalledTimes(1);
});

test("conflicting records and source row batches never silently merge", () => {
  expect(mergeDocumentInputProposals(schema, [{ fields: { customer_name: "A" } }, { fields: { customer_name: "B", quantity: 2 } }])).toMatchObject({ values: { quantity: 2 }, blocked: true });
  expect(mergeDocumentInputProposals(schema, [{ fields: { customer_name: "A" } }, { rows: [{ customer_name: "B" }] }])).toMatchObject({ values: {}, blocked: true });
});

test("more than six files are rejected before upload", async () => {
  mount(); await chooseMany(7);
  expect(screen.getByRole("alert").textContent).toContain("up to six");
  expect(documents.prepare).not.toHaveBeenCalled();
});

test("a multi-customer PDF requires explicit row selection and a fresh source review after changing records", async () => {
  const onRun = jest.fn();
  documents.prepare.mockResolvedValue({ ...prepared, attachment: { ...prepared.attachment, filename: "customers.pdf", fields: {}, rows: [{ customer_name: "First", quantity: 1 }, { customer_name: "Second" }] } });
  mount({ onRun }); await choose("customers.pdf"); fireEvent.click(screen.getByRole("button", { name: "Read document" }));
  const select = await screen.findByRole("combobox", { name: "Record for this run" });
  expect(select.value).toBe(""); expect(screen.getByRole("button", { name: "Use extracted values" }).disabled).toBe(true);
  fireEvent.change(select, { target: { value: "0" } }); fireEvent.click(screen.getByRole("button", { name: "Use extracted values" }));
  expect(screen.getByLabelText("Customer name").value).toBe("First");
  fireEvent.click(screen.getByLabelText("I checked these inputs against the source document"));
  expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(false);
  fireEvent.change(select, { target: { value: "1" } });
  expect(screen.getByLabelText("Customer name").value).toBe(""); expect(screen.getByLabelText("I checked these inputs against the source document").checked).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Use extracted values" }));
  expect(screen.getByLabelText("Customer name").value).toBe("Second"); expect(screen.getByLabelText("Quantity").value).toBe("");
  expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(true); expect(onRun).not.toHaveBeenCalled();
});

test("separate image and PDF customers reuse the same schema without merging identities", async () => {
  documents.prepare.mockResolvedValueOnce({ ...prepared, attachment: { ...prepared.attachment, fields: { customer_name: "Image Customer", quantity: 1 } } })
    .mockResolvedValueOnce({ ...prepared, attachment: { ...prepared.attachment, fields: { customer_name: "PDF Customer", quantity: 3 } } });
  mount(); fireEvent.click(screen.getByRole("button", { name: "Fill inputs from a document" })); await waitFor(() => expect(chatService.models).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("Workflow input document"), { target: { files: [new File(["image"], "one.png"), new File(["pdf"], "two.pdf")] } });
  fireEvent.click(screen.getByRole("button", { name: "Read documents" }));
  const separate = await screen.findByRole("checkbox", { name: "These files contain separate customers or records." }); fireEvent.click(separate);
  const select = screen.getByRole("combobox", { name: "Record for this run" }); expect(select.textContent).toContain("one.png"); expect(select.textContent).toContain("two.pdf");
  fireEvent.change(select, { target: { value: "1" } }); fireEvent.click(screen.getByRole("button", { name: "Use extracted values" }));
  expect(screen.getByLabelText("Customer name").value).toBe("PDF Customer"); expect(screen.getByLabelText("Quantity").value).toBe("3");
});
