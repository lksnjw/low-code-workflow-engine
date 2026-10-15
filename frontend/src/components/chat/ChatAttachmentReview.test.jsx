/** @jest-environment jsdom */
import React from "react";
import { jest, test, expect, afterEach } from "@jest/globals";
import "@testing-library/jest-dom/jest-globals";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
const service = Object.fromEntries(["get", "catalog", "confirm", "recover"].map(name => [name, jest.fn()]));
jest.unstable_mockModule("../../services/document-workspace.service", () => ({ documentWorkspaceService: service }));
const { default: Review } = await import("./ChatAttachmentReview");
const schema = { id: "customer", revision: 1, source_system_id: "erpnext", source_entity: "Customer", fields: [{ name: "customer_name", type: "string", required: true }] };
const attachment = { filename: "customer.png", sessionId: "chat", uploadId: "upload", storage: "STAGED", summary: "Customer", fields: {}, warnings: [] };
afterEach(() => { cleanup(); jest.clearAllMocks(); });
test("missing fields are corrected and explicitly reviewed before pipeline-only confirmation", async () => {
  service.get.mockResolvedValue({ revision: 1, status: "REVIEW", proposal: { schemaId: "customer", documentType: "registration_form", fields: {} } });
  service.catalog.mockResolvedValue({ entities: [schema] });
  service.confirm.mockResolvedValue({ status: "READY", document_id: "doc", version: 1, vector_collection: "schema-collection" });
  const saved = jest.fn(); render(<Review attachment={attachment} onSaved={saved} />);
  fireEvent.click(screen.getByRole("button", { name: "Check document & review fields" }));
  await screen.findByText("customer_name is required.");
  expect(screen.getByRole("button", { name: "Confirm & save document" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Document 1 customer_name"), { target: { value: "Client A" } });
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Confirm & save document" }));
  await screen.findByText(/Saved and searchable/);
  expect(service.confirm).toHaveBeenCalledWith("chat", "upload", expect.objectContaining({ form_fields: { customer_name: "Client A" }, review_confirmed: true, chat_receipt: true }));
  expect(saved).toHaveBeenCalledTimes(1);
});
test("model-only fallback does not offer a fake storage or approve button", () => {
  render(<Review attachment={{ ...attachment, uploadId: undefined, storage: "UNAVAILABLE" }} />);
  expect(screen.getByText(/no vector save or later retrieval is confirmed/)).toBeTruthy(); expect(screen.queryByRole("button")).toBeNull();
});
test("a late original upload receipt replaces the unconfirmed storage label without claiming indexing", async () => {
  service.get.mockResolvedValue({ id: "upload", revision: 2, status: "REVIEW", proposal: { schemaId: "customer", documentType: "registration_form", fields: { customer_name: "A" } } });
  service.catalog.mockResolvedValue({ entities: [schema] });
  render(<Review attachment={{ ...attachment, storage: "UNCONFIRMED" }} />);
  fireEvent.click(screen.getByRole("button", { name: "Check document & review fields" }));
  await screen.findByText("Uploaded · review before indexing");
  expect(screen.getByText(/original upload has now been found/)).toBeTruthy();
  expect(screen.queryByText("Searchable")).toBeNull(); expect(service.confirm).not.toHaveBeenCalled();
});
test("only a searchable reviewed receipt offers the exact document workflow handoff", async () => {
  const use = jest.fn(); const view = render(<Review attachment={attachment} onUseForWorkflow={use} />);
  expect(screen.queryByRole("button", { name: "Create customer or record workflow" })).toBeNull();
  view.rerender(<Review attachment={attachment} indexed={{ uploadId: "upload", documentId: "doc", version: 2 }} onUseForWorkflow={use} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create customer or record workflow" }));
  expect(use).toHaveBeenCalledWith({ uploadId: "upload", documentId: "doc", version: 2, purpose: "erp_record_proposal" });
  expect(service.confirm).not.toHaveBeenCalled();
});
test("a saved chat receipt restores Searchable without reloading every file or showing stale preparation warnings", async () => {
  render(<Review attachment={{ ...attachment, warnings: ["Preparation pending"] }} indexed={{ uploadId: "upload", documentId: "doc", version: 1, collection: "schema-collection" }} />);
  await screen.findByText(/Saved and searchable/);
  expect(screen.queryByText("Preparation pending")).toBeNull(); expect(service.get).not.toHaveBeenCalled(); expect(service.confirm).not.toHaveBeenCalled();
});
test("lost confirmation stays locked and refresh never repeats the mutation", async () => {
  service.get.mockResolvedValue({ revision: 1, status: "REVIEW", proposal: { schemaId: "customer", documentType: "registration_form", fields: { customer_name: "A" } } });
  service.catalog.mockResolvedValue({ entities: [schema] }); service.confirm.mockRejectedValue(new Error("Lost response"));
  render(<Review attachment={attachment} />);
  fireEvent.click(screen.getByRole("button", { name: "Check document & review fields" })); await screen.findByRole("checkbox");
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Confirm & save document" }));
  await screen.findByText(/confirmation was not received/); expect(screen.getByRole("button", { name: "Confirm & save document" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Check document & review fields" })); await waitFor(() => expect(service.get).toHaveBeenCalledTimes(2));
  expect(service.confirm).toHaveBeenCalledTimes(1); expect(screen.getByRole("button", { name: "Confirm & save document" })).toBeDisabled();
});
test("interrupted indexing offers server-fenced recovery without replaying confirmation", async () => {
  service.get.mockResolvedValue({ id: "upload", revision: 3, status: "INDEXING", proposal: { schemaId: "customer", documentType: "registration_form", fields: { customer_name: "A" } } });
  service.catalog.mockResolvedValue({ entities: [schema] });
  service.recover.mockResolvedValue({ id: "upload", revision: 4, status: "INTERRUPTED" });
  render(<Review attachment={attachment} />);
  fireEvent.click(screen.getByRole("button", { name: "Check document & review fields" }));
  fireEvent.click(await screen.findByRole("button", { name: "Recover interrupted processing" }));
  await waitFor(() => expect(service.recover).toHaveBeenCalledWith("chat", "upload", 3));
  expect(service.confirm).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Confirm & save document" })).toBeDisabled();
});

test("shows the schema-derived restricted destination before indexing a medical document", () => {
  const medicalSchema = { ...schema, source_entity: "employee", collection_routes: [{ collection: "hr_employee_restricted", tier: "restricted", document_types: ["medical_certificate"], accepts_uploads: true, description: "Private medical attachments" }] };
  render(<Review attachment={attachment} initialSchema={medicalSchema} initialUpload={{ status: "REVIEW", revision: 1, proposal: { documentType: "medical_certificate", fields: { customer_name: "Fictional record" } } }} />);
  expect(screen.getByLabelText("Detected document destination")).toHaveTextContent("Restricted document collection");
  expect(screen.getByText("hr_employee_restricted")).toBeTruthy();
  expect(service.confirm).not.toHaveBeenCalled();
});

test("never guesses between ambiguous schema collection destinations", () => {
  const route = { collection: "one", tier: "restricted", document_types: ["medical_certificate"], accepts_uploads: true };
  render(<Review attachment={attachment} initialSchema={{ ...schema, collection_routes: [route, { ...route, collection: "two" }] }} initialUpload={{ status: "REVIEW", revision: 1, proposal: { documentType: "medical_certificate", fields: { customer_name: "Fictional record" } } }} />);
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("alert")).toHaveTextContent("no collection will be guessed");
  expect(screen.getByRole("button", { name: "Confirm & save document" })).toBeDisabled();
  expect(service.confirm).not.toHaveBeenCalled();
});

test("restricted cloud-storage denial is visible and cannot be bypassed by the review checkbox", () => {
  render(<Review attachment={attachment} initialSchema={schema} initialUpload={{ status: "INDEX_FAILED", error_code: "STORAGE_POLICY_DENIED", revision: 3, proposal: { documentType: "medical_certificate", fields: { customer_name: "Fictional record" } } }} />);
  expect(screen.getByRole("alert")).toHaveTextContent("approved on-premises vector location");
  expect(screen.getByRole("alert")).toHaveTextContent("not searchable");
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Confirm & save document" })).toBeDisabled();
  expect(service.confirm).not.toHaveBeenCalled();
});

test("prototype restricted storage requires a separate fictional-source declaration and never enables sharing", async () => {
  const medicalSchema = { ...schema, collection_routes: [{ collection: "restricted", tier: "restricted", document_types: ["medical_certificate"], accepts_uploads: true, requires_synthetic_confirmation: true }] };
  service.confirm.mockResolvedValue({ status: "READY", document_id: "doc", version: 1, vector_collection: "restricted" });
  render(<Review attachment={attachment} initialSchema={medicalSchema} initialUpload={{ status: "REVIEW", revision: 1, proposal: { documentType: "medical_certificate", fields: { customer_name: "Fictional record" } } }} />);
  fireEvent.click(screen.getByRole("checkbox", { name: /I checked the extracted fields/ }));
  expect(screen.getByRole("button", { name: "Confirm & save document" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "This file contains no real personal or medical information." }));
  expect(screen.getByRole("checkbox", { name: /I checked the extracted fields/ })).not.toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: /I checked the extracted fields/ }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm & save document" }));
  await screen.findByText(/Saved and searchable/);
  expect(service.confirm).toHaveBeenCalledWith("chat", "upload", expect.objectContaining({ synthetic_source_confirmed: true }));
  expect(service.confirm.mock.calls[0][2].share_with_schema_roles).toBeUndefined();
});
