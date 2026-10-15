/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import "@testing-library/jest-dom/jest-globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
const models = jest.fn(), createSession = jest.fn(), prepare = jest.fn(), catalog = jest.fn();
jest.unstable_mockModule("../../services/chat.service", () => ({ chatService: { models, createSession } }));
jest.unstable_mockModule("../../services/document-workspace.service", () => ({ documentWorkspaceService: { prepare, catalog } }));
const { default: Intake } = await import("./SmartDocumentIntake");
const schema = { id: "customer", revision: 1, source_system_id: "erpnext", source_entity: "Customer", fields: [{ name: "customer_name", type: "string", required: true }], document_types: ["registration_form"] };
const mount = () => render(<MemoryRouter><Intake /></MemoryRouter>);
beforeEach(() => {
  [models, createSession, prepare, catalog].forEach(mock => mock.mockReset());
  models.mockResolvedValue({ configured: true, binding: { model: "vision-model" }, models: ["vision-model"] });
  catalog.mockResolvedValue({ entities: [schema] }); createSession.mockResolvedValue({ id: "intake-chat" });
  prepare.mockResolvedValue({ attachment: { filename: "form.png", storage: "STAGED", uploadId: "upload-1", fields: { customer_name: "Client A" }, warnings: [] }, upload: { revision: 2, status: "REVIEW", proposal: { schemaId: "customer", documentType: "registration_form", fields: { customer_name: "Client A" } } } });
});
afterEach(cleanup);
const choose = () => fireEvent.change(screen.getByLabelText("Choose a business document"), { target: { files: [new File(["image"], "form.png")] } });
test("document upload automatically prepares fields without asking for technical identifiers", async () => {
  mount(); await waitFor(() => expect(screen.getByLabelText("Choose a business document")).not.toBeDisabled());
  choose(); fireEvent.click(screen.getByRole("button", { name: "Read document" }));
  expect(await screen.findByLabelText("Document 1 customer_name")).toHaveValue("Client A");
  expect(prepare).toHaveBeenCalledWith("intake-chat", expect.any(File), expect.objectContaining({ schemaId: "", model: "vision-model", saveToConversation: true }));
  expect(screen.queryByRole("combobox", { name: "Document model" })).toBeNull();
  expect(document.body.textContent).not.toContain("vision-model");
  expect(screen.queryByLabelText("Source system ID")).toBeNull(); expect(screen.queryByLabelText("Business key name")).toBeNull();
  expect(screen.getByRole("button", { name: "Confirm & save document" })).toBeDisabled();
  expect(screen.getByRole("link", { name: "Continue in chat" })).toHaveAttribute("href", "/chat/intake-chat");
});
test("duplicate clicks are blocked while reading and missing fields remain empty", async () => {
  let resolve; prepare.mockImplementation(() => new Promise(done => { resolve = done; }));
  mount(); await waitFor(() => expect(screen.getByLabelText("Choose a business document")).not.toBeDisabled()); choose();
  fireEvent.click(screen.getByRole("button", { name: "Read document" }));
  await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText("Choose a business document")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Reading and sorting document…" })).toBeDisabled();
  resolve({ attachment: { filename: "form.png", uploadId: "upload-1", fields: {}, warnings: [] }, upload: { revision: 1, status: "REVIEW", proposal: { schemaId: "customer", documentType: "registration_form", fields: {} } } });
  expect(await screen.findByText("customer_name is required.")).toBeVisible();
});
test("lost preparation keeps the conversation and reuses the same upload identity", async () => {
  prepare.mockRejectedValue(new Error("Response was not confirmed")); mount();
  await waitFor(() => expect(screen.getByLabelText("Choose a business document")).not.toBeDisabled()); choose();
  fireEvent.click(screen.getByRole("button", { name: "Read document" })); await screen.findByRole("alert");
  const key = prepare.mock.calls[0][2].idempotencyKey;
  fireEvent.click(screen.getByRole("button", { name: "Read document" }));
  await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
  expect(prepare.mock.calls[1][2].idempotencyKey).toBe(key); expect(createSession).toHaveBeenCalledTimes(1);
});
test("pipeline outage shows model-only interpretation without claiming storage", async () => {
  prepare.mockResolvedValue({ attachment: { filename: "form.png", storage: "UNAVAILABLE", fields: { customer_name: "Client A" }, warnings: [] } });
  mount(); await waitFor(() => expect(screen.getByLabelText("Choose a business document")).not.toBeDisabled()); choose();
  fireEvent.click(screen.getByRole("button", { name: "Read document" }));
  expect(await screen.findByText(/no vector save or later retrieval is confirmed/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Confirm & save document" })).toBeNull();
});
