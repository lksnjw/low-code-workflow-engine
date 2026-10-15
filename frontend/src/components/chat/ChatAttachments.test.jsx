/** @jest-environment jsdom */
import React from "react";
import "@testing-library/jest-dom/jest-globals";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const service = Object.fromEntries(["catalog", "inventory", "list", "get", "stage", "analyse", "confirm", "recover", "preview"].map(name => [name, jest.fn()]));
jest.unstable_mockModule("../../services/document-workspace.service", () => ({ documentWorkspaceService: service }));
const { default: Attachments } = await import("./ChatAttachments");
const schema = { id: "schema", revision: 1, source_system_id: "hr", source_entity: "members", primary_key: "member_id", minimum_sensitivity: "confidential", reader_roles: [],
  fields: [{ name: "member_id", type: "string", generated: true }, { name: "name", type: "string", required: true }], document_types: ["registration_form"] };
const staged = { id: "upload", revision: 1, filename: "form.txt", session_id: "chat", status: "REVIEW", warnings: [] };
const preview = { status: "MODEL_PREVIEW", summary: "Two proposed clients", fields: {}, rows: [{ customer_name: "Client A" }, { customer_name: "Client B" }], missingInformation: [], warnings: [], model: "selected-model", sourceContentHash: "source-hash", pipelineStorageConfirmed: false };
beforeEach(() => {
  Object.values(service).forEach(mock => mock.mockReset());
  service.catalog.mockResolvedValue({ entities: [schema] }); service.inventory.mockResolvedValue({ as_of: new Date().toISOString(), searchable_documents: 0, pending_review: 1, counts_complete: true, vector_index_configured: true, documents: [] });
  service.list.mockResolvedValue({ items: [] }); service.stage.mockResolvedValue(staged);
  service.preview.mockResolvedValue(preview);
  service.analyse.mockResolvedValue(staged);
  service.confirm.mockResolvedValue({ ...staged, status: "READY", document_id: "doc", version: 1, pipeline_record_id: "record" });
});
afterEach(() => { cleanup(); jest.useRealTimers(); });
async function open(props = {}) { const view = render(<Attachments sessionId="chat" model="test-model" {...props} />); fireEvent.click(screen.getByRole("button", { name: /Documents & forms/ })); await screen.findByText(/0 permitted searchable/); return view; }
function chooseAndUpload() {
  fireEvent.change(screen.getByLabelText("Choose chat attachment"), { target: { files: [new File(["Name: Example"], "form.txt")] } });
  fireEvent.click(screen.getByRole("button", { name: "Upload privately" }));
}
async function stage() {
  chooseAndUpload(); await screen.findByText(/Uploaded privately/);
  fireEvent.change(screen.getByRole("combobox", { name: "Entity schema" }), { target: { value: "schema" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Document type" }), { target: { value: "registration_form" } });
}
test("unsupported files never leave the browser", async () => {
  await open(); fireEvent.change(screen.getByLabelText("Choose chat attachment"), { target: { files: [new File(["MZ"], "file.exe")] } });
  fireEvent.click(screen.getByRole("button", { name: "Upload privately" })); expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported file type"); expect(service.stage).not.toHaveBeenCalled();
});
test("manual review requires confirmation and returns a pipeline receipt", async () => {
  await open(); await stage(); fireEvent.change(screen.getByLabelText("name *"), { target: { value: "Reviewed Example" } });
  const button = screen.getByRole("button", { name: "Confirm & index" }); expect(button).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /I checked the source/ })); fireEvent.click(button);
  await waitFor(() => expect(service.confirm).toHaveBeenCalled());
  expect(service.confirm.mock.calls[0][2]).toMatchObject({ create_record: true, form_fields: { name: "Reviewed Example" }, review_confirmed: true });
  expect(await screen.findByText(/no original ERP record was created/)).toBeTruthy();
});

test("a new document version retains its pipeline record and is not labelled as another record creation", async () => {
  service.inventory.mockResolvedValue({ as_of: new Date().toISOString(), searchable_documents: 0, pending_review: 1, counts_complete: true, vector_index_configured: true,
    documents: [{ id: "doc", schema_id: "schema", document_type: "registration_form", current_upload_id: "old-upload", revision: 4, version: 1 }] });
  service.confirm.mockResolvedValue({ ...staged, status: "READY", document_id: "doc", version: 2, pipeline_record_id: "record" });
  await open(); await stage();
  fireEvent.change(screen.getByLabelText("name *"), { target: { value: "Reviewed Example" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Document version" }), { target: { value: "doc" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /I checked the source/ }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm & index" }));
  await waitFor(() => expect(service.confirm).toHaveBeenCalled());
  expect(service.confirm.mock.calls[0][2]).toMatchObject({ mode: "version", document_id: "doc", document_revision: 4 });
  expect(await screen.findByText(/Document version indexed; existing pipeline record retained/)).toBeTruthy();
  expect(screen.queryByText(/Pipeline record created;/)).toBeNull();
});

test("selected schema and type show a server-derived destination; changing type clears human review", async () => {
  service.catalog.mockResolvedValue({ entities: [{ ...schema, document_types: ["registration_form", "medical_certificate"], collection_routes: [
    { collection: "hr_members_standard", tier: "standard", source_system_id: "hr", source_entity: "members", accepts_uploads: true, document_types: ["registration_form"], searchable_documents: 3, description: "Reviewed registrations" },
    { collection: "hr_members_restricted", tier: "restricted", source_system_id: "hr", source_entity: "members", accepts_uploads: true, document_types: ["medical_certificate"], searchable_documents: 1, description: "Restricted owner-only documents" }] }] });
  await open(); await stage();
  fireEvent.change(screen.getByLabelText("name *"), { target: { value: "Reviewed Example" } });
  expect(screen.getByLabelText("Upload collection destination")).toHaveTextContent("hr_members_standard");
  const review = screen.getByRole("checkbox", { name: /I checked the source/ }); fireEvent.click(review);
  fireEvent.change(screen.getByRole("combobox", { name: "Document type" }), { target: { value: "medical_certificate" } });
  expect(review).not.toBeChecked(); expect(screen.getByLabelText("Upload collection destination")).toHaveTextContent("Restricted · owner only");
  expect(screen.getByLabelText("Upload collection destination")).toHaveTextContent("hr_members_restricted");
  fireEvent.click(review); fireEvent.click(screen.getByRole("button", { name: "Confirm & index" }));
  await waitFor(() => expect(service.confirm).toHaveBeenCalled());
  expect(service.confirm.mock.calls[0][2]).not.toHaveProperty("collection"); expect(service.confirm.mock.calls[0][2]).not.toHaveProperty("vector_collection");
});
test("double-click upload sends one stable idempotent request", async () => {
  service.stage.mockReturnValue(new Promise(() => {})); await open();
  fireEvent.change(screen.getByLabelText("Choose chat attachment"), { target: { files: [new File(["Example"], "form.txt")] } });
  const button = screen.getByRole("button", { name: "Upload privately" }); fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(service.stage).toHaveBeenCalledTimes(1)); expect(service.stage.mock.calls[0][2]).toBeTruthy(); expect(button).toBeDisabled();
});

test("an upload handoff timeout exposes a receipt check, keeps its request identity and never replays on status refresh", async () => {
  service.stage.mockRejectedValueOnce(Object.assign(new Error("Upload outcome unconfirmed"), { status: 504, code: "PIPELINE_HANDOFF_TIMEOUT" }));
  service.list.mockResolvedValueOnce({ items: [] });
  await open(); chooseAndUpload();
  await screen.findByLabelText("Unconfirmed document upload");
  const key = service.stage.mock.calls[0][2]; expect(key).toBeTruthy();
  service.list.mockResolvedValue({ items: [{ ...staged, filename: "form.txt" }] });
  fireEvent.click(screen.getByRole("button", { name: "Check upload status" }));
  await screen.findByText(/Saved attachments loaded/);
  expect(screen.getByRole("combobox", { name: "Uploaded in this conversation" })).toBeTruthy();
  expect(service.stage).toHaveBeenCalledTimes(1); expect(service.confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry same upload request" }));
  await waitFor(() => expect(service.stage).toHaveBeenCalledTimes(2));
  expect(service.stage.mock.calls[1][2]).toBe(key); expect(service.stage.mock.calls[1][1]).toBe(service.stage.mock.calls[0][1]);
  expect(service.confirm).not.toHaveBeenCalled();
});
test("missing mandatory fields explain the disabled confirmation beside the case", async () => {
  await open(); await stage();
  fireEvent.click(screen.getByRole("checkbox", { name: /I checked the source/ }));
  expect(screen.getByRole("status", { name: "Document fields needing attention" })).toHaveTextContent("name is required.");
  expect(screen.getByRole("button", { name: "Confirm & index" })).toBeDisabled();
  expect(service.confirm).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("name *"), { target: { value: "Corrected name" } });
  expect(screen.queryByRole("status", { name: "Document fields needing attention" })).toBeNull();
  expect(screen.getByRole("button", { name: "Confirm & index" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /I checked the source/ }));
  expect(screen.getByRole("button", { name: "Confirm & index" })).not.toBeDisabled();
});
test("failed confirmation stays inline with the original upload and no automatic replay", async () => {
  service.confirm.mockRejectedValue(new Error("Required field territory is missing."));
  await open(); await stage(); fireEvent.change(screen.getByLabelText("name *"), { target: { value: "QA" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /I checked the source/ }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm & index" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Required field territory is missing.");
  expect(screen.getByText("form.txt · Waiting for review")).toBeTruthy();
  expect(service.confirm).toHaveBeenCalledTimes(1);
});
test("editing a member row clears earlier confirmation", async () => {
  await open(); await stage(); fireEvent.click(screen.getByRole("checkbox", { name: /Review multiple members/ })); fireEvent.click(screen.getByRole("button", { name: "Add review row" }));
  fireEvent.change(screen.getByLabelText("Row 1 name"), { target: { value: "Member One" } }); fireEvent.change(screen.getByLabelText("Row 2 name"), { target: { value: "Member Two" } });
  const review = screen.getByRole("checkbox", { name: /I checked the source/ }); fireEvent.click(review);
  fireEvent.change(screen.getByLabelText("Row 2 name"), { target: { value: "Corrected Member" } }); expect(review).not.toBeChecked();
  fireEvent.click(review); fireEvent.click(screen.getByRole("button", { name: "Confirm & index" }));
  await waitFor(() => expect(service.confirm).toHaveBeenCalled()); expect(service.confirm.mock.calls[0][2].form_rows).toEqual([{ name: "Member One" }, { name: "Corrected Member" }]);
});
test("ambiguous ERP names never select a record automatically", async () => {
  service.list.mockResolvedValue({ items: [staged] }); service.get.mockResolvedValue({ ...staged, proposal: { schemaId: "schema", documentType: "registration_form", createRecord: false, fields: {}, choices: [{ id: "a", schemaId: "schema", label: "Same Name — A" }, { id: "b", schemaId: "schema", label: "Same Name — B" }] } });
  await open(); fireEvent.change(screen.getByRole("combobox", { name: "Uploaded in this conversation" }), { target: { value: "upload" } });
  const select = await screen.findByRole("combobox", { name: "Verified ERP match (choose explicitly)" }); expect(select.value).toBe("");
  fireEvent.click(screen.getByRole("checkbox", { name: /I checked the source/ })); expect(screen.getByRole("button", { name: "Confirm & index" })).toBeDisabled(); expect(service.confirm).not.toHaveBeenCalled();
});
test("ERP workflow handoff contains identity/version, not file bytes or fields", async () => {
  const onUseForWorkflow = jest.fn(); service.list.mockResolvedValue({ items: [{ ...staged, status: "READY" }] });
  service.get.mockResolvedValue({ ...staged, status: "READY", document_id: "doc", version: 2, extracted_text: "Private source" });
  await open({ onUseForWorkflow }); fireEvent.change(screen.getByRole("combobox", { name: "Uploaded in this conversation" }), { target: { value: "upload" } });
  fireEvent.click(await screen.findByRole("button", { name: "Use reviewed data for ERP workflow" })); expect(onUseForWorkflow).toHaveBeenCalledWith({ uploadId: "upload", documentId: "doc", version: 2, purpose: "erp_record_proposal" });
});

test("a slow document operation gives a ten-second notice without disabling an unrelated chat composer", async () => {
  service.stage.mockReturnValue(new Promise(() => {}));
  render(<><textarea aria-label="Normal chat message" /><Attachments sessionId="chat" model="selected-model" /></>);
  fireEvent.click(screen.getByRole("button", { name: /Documents & forms/ })); await screen.findByText(/0 permitted searchable/);
  jest.useFakeTimers();
  fireEvent.change(screen.getByLabelText("Choose chat attachment"), { target: { files: [new File(["Example"], "form.txt")] } });
  fireEvent.click(screen.getByRole("button", { name: "Upload privately" }));
  await act(async () => { jest.advanceTimersByTime(10000); });
  expect(screen.getByText(/Preparing a document preview while storage is checked separately/)).toBeTruthy();
  const composer = screen.getByLabelText("Normal chat message"); fireEvent.change(composer, { target: { value: "Continue my conversation" } });
  expect(composer).not.toBeDisabled(); expect(composer.value).toBe("Continue my conversation");
  expect(service.stage).toHaveBeenCalledTimes(1); expect(service.confirm).not.toHaveBeenCalled();
});

test("image model preview starts after ten seconds while OCR remains pending; storage stays blocked", async () => {
  const extracting = { ...staged, filename: "form.png", status: "EXTRACTING" };
  service.stage.mockResolvedValue(extracting);
  service.get.mockResolvedValue(extracting);
  await open({ model: "selected-vision-model" });
  jest.useFakeTimers();
  fireEvent.change(screen.getByLabelText("Choose chat attachment"), { target: { files: [new File(["image fixture"], "form.png")] } });
  fireEvent.click(screen.getByRole("button", { name: "Upload privately" }));
  await act(async () => {});
  await act(async () => { jest.advanceTimersByTime(9999); }); expect(service.preview).not.toHaveBeenCalled();
  await act(async () => { jest.advanceTimersByTime(1); });
  expect(service.preview).toHaveBeenCalledWith("chat", expect.any(File), expect.objectContaining({ model: "selected-vision-model" }));
  expect(service.analyse).not.toHaveBeenCalled(); expect(screen.getByLabelText("Provisional document preview")).toHaveTextContent("Two proposed clients");
  fireEvent.change(screen.getByRole("combobox", { name: "Entity schema" }), { target: { value: "schema" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Document type" }), { target: { value: "registration_form" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /I checked the source/ }));
  expect(screen.getByRole("button", { name: "Confirm & index" })).toBeDisabled();
  expect(service.confirm).not.toHaveBeenCalled();
});

test("a fully unavailable pipeline still offers reviewed model-preview chat/workflow requests without claiming storage", async () => {
  service.catalog.mockRejectedValue(new Error("Pipeline not configured"));
  service.stage.mockRejectedValue(Object.assign(new Error("Offline"), { status: 503, code: "PIPELINE_UNAVAILABLE" }));
  const onUseModelPreview = jest.fn();
  render(<Attachments sessionId="chat" model="selected-model" onUseModelPreview={onUseModelPreview} canAuthorWorkflows />);
  fireEvent.click(screen.getByRole("button", { name: /Documents & forms/ }));
  await screen.findByText("Pipeline not configured");
  fireEvent.change(screen.getByLabelText("Choose chat attachment"), { target: { files: [new File(["%PDF-1.7 fixture"], "clients.pdf")] } });
  fireEvent.click(screen.getByRole("button", { name: "Upload privately" }));
  await screen.findByLabelText("Provisional document preview");
  expect(screen.getByText(/Pipeline storage was not confirmed/)).toBeTruthy();
  const use = screen.getByRole("button", { name: "Use reviewed preview in chat" }); expect(use).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /I checked these provisional values/ })); fireEvent.click(use);
  expect(onUseModelPreview).toHaveBeenCalledWith(preview, { instruction: "", asWorkflow: false });
  fireEvent.click(screen.getByRole("button", { name: "Prepare workflow request from preview" }));
  expect(onUseModelPreview).toHaveBeenLastCalledWith(preview, { instruction: "", asWorkflow: true, prepareSchedule: false });
  expect(service.confirm).not.toHaveBeenCalled(); expect(service.analyse).not.toHaveBeenCalled();
});

test("fast schema-bound analysis prevents duplicate fallback inference", async () => {
  await open({ model: "selected-model" }); jest.useFakeTimers(); await stage();
  await act(async () => { jest.advanceTimersByTime(11000); });
  expect(service.analyse).toHaveBeenCalledTimes(1); expect(service.preview).not.toHaveBeenCalled();
});

test("model assistance opt-out does not send the file after the ten-second threshold", async () => {
  service.stage.mockReturnValue(new Promise(() => {})); await open({ model: "selected-model" });
  fireEvent.click(screen.getByRole("checkbox", { name: /Prepare a document preview automatically/ })); jest.useFakeTimers(); chooseAndUpload();
  await act(async () => { jest.advanceTimersByTime(11000); }); expect(service.preview).not.toHaveBeenCalled(); expect(service.analyse).not.toHaveBeenCalled();
});

test("turning off model assistance after an accepted upload cancels the pending ten-second handoff", async () => {
  const extracting = { ...staged, status: "EXTRACTING" };
  service.stage.mockResolvedValue(extracting); service.get.mockResolvedValue(extracting);
  await open({ model: "selected-model" }); jest.useFakeTimers(); chooseAndUpload(); await act(async () => {});
  const checkbox = screen.getByRole("checkbox", { name: /Prepare a document preview automatically/ }); expect(checkbox).not.toBeDisabled(); fireEvent.click(checkbox);
  await act(async () => { jest.advanceTimersByTime(11000); });
  expect(service.preview).not.toHaveBeenCalled(); expect(service.analyse).not.toHaveBeenCalled();
});

test("upload authorization failure cannot trigger model fallback", async () => {
  service.stage.mockRejectedValue(Object.assign(new Error("Not permitted"), { status: 403 }));
  await open({ model: "selected-model" }); jest.useFakeTimers(); chooseAndUpload(); await act(async () => {});
  await act(async () => { jest.advanceTimersByTime(11000); }); expect(service.preview).not.toHaveBeenCalled(); expect(screen.getByRole("alert")).toHaveTextContent("Not permitted");
});

test("late model previews are fenced when the user changes conversations", async () => {
  let finish; service.stage.mockRejectedValue(Object.assign(new Error("Offline"), { status: 503 }));
  service.preview.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = await open({ model: "selected-model" }); chooseAndUpload();
  await waitFor(() => expect(service.preview).toHaveBeenCalledTimes(1));
  view.rerender(<Attachments sessionId="other-chat" model="selected-model" />);
  await act(async () => { finish(preview); });
  expect(screen.queryByLabelText("Provisional document preview")).toBeNull();
});

test("OCR completion invalidates old confirmation without replacing manually edited fields", async () => {
  const extracting = { ...staged, status: "EXTRACTING" };
  service.stage.mockResolvedValue(extracting);
  service.get.mockResolvedValue({ ...staged, revision: 3 });
  await open();
  fireEvent.click(screen.getByRole("checkbox", { name: /Prepare a document preview automatically/ }));
  await stage();
  fireEvent.change(screen.getByLabelText("name *"), { target: { value: "My manual correction" } });
  const review = screen.getByRole("checkbox", { name: /I checked the source/ }); fireEvent.click(review);
  await waitFor(() => expect(service.get).toHaveBeenCalled(), { timeout: 4000 });
  await waitFor(() => expect(review).not.toBeChecked());
  expect(screen.getByDisplayValue("My manual correction")).toBeTruthy();
  expect(service.analyse).not.toHaveBeenCalled();
});

test("a late upload cannot populate another conversation or start model analysis there", async () => {
  let finish;
  service.stage.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = render(<Attachments sessionId="chat" model="selected-model" />);
  fireEvent.click(screen.getByRole("button", { name: /Documents & forms/ })); await screen.findByText(/0 permitted searchable/);
  fireEvent.change(screen.getByLabelText("Choose chat attachment"), { target: { files: [new File(["Example"], "form.txt")] } });
  fireEvent.click(screen.getByRole("button", { name: "Upload privately" }));
  view.rerender(<Attachments sessionId="another-chat" model="selected-model" />);
  await act(async () => { finish(staged); });
  expect(screen.queryByText(/Uploaded privately/)).toBeNull();
  expect(screen.queryByText("form.txt · Waiting for review")).toBeNull();
  expect(service.analyse).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Choose chat attachment")).not.toBeDisabled();
});

test("switching away and back does not revive a stale document request", async () => {
  let finish;
  service.stage.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = render(<Attachments sessionId="chat" model="selected-model" />);
  fireEvent.click(screen.getByRole("button", { name: /Documents & forms/ })); await screen.findByText(/0 permitted searchable/);
  fireEvent.change(screen.getByLabelText("Choose chat attachment"), { target: { files: [new File(["Example"], "form.txt")] } });
  fireEvent.click(screen.getByRole("button", { name: "Upload privately" }));
  view.rerender(<Attachments sessionId="another-chat" model="selected-model" />);
  view.rerender(<Attachments sessionId="chat" model="selected-model" />);
  await act(async () => { finish(staged); });
  expect(service.analyse).not.toHaveBeenCalled();
  expect(screen.queryByText(/Uploaded privately/)).toBeNull();
});

test("reviewed PDF handoff retains client-import and schedule requirements but never includes file data", async () => {
  const onUseForWorkflow = jest.fn();
  service.list.mockResolvedValue({ items: [{ ...staged, status: "READY", filename: "clients.pdf" }] });
  service.get.mockResolvedValue({ ...staged, status: "READY", filename: "clients.pdf", document_id: "clients-doc", version: 3, extracted_text: "Private client list" });
  await open({ onUseForWorkflow });
  fireEvent.change(screen.getByRole("combobox", { name: "Uploaded in this conversation" }), { target: { value: "upload" } });
  const request = await screen.findByRole("textbox", { name: "Workflow request" });
  fireEvent.change(request, { target: { value: "Add these clients, check duplicates and prepare tomorrow's schedule." } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Also assess scheduling requirements" }));
  fireEvent.click(screen.getByRole("button", { name: "Use reviewed data for ERP workflow" }));
  expect(onUseForWorkflow).toHaveBeenCalledWith({ uploadId: "upload", documentId: "clients-doc", version: 3, purpose: "erp_record_proposal" },
    { instruction: "Add these clients, check duplicates and prepare tomorrow's schedule.", prepareSchedule: true });
  expect(JSON.stringify(onUseForWorkflow.mock.calls)).not.toContain("Private client list"); expect(service.confirm).not.toHaveBeenCalled();
});

test("upload-only users can review documents but are not offered workflow authoring", async () => {
  service.list.mockResolvedValue({ items: [{ ...staged, status: "READY" }] });
  service.get.mockResolvedValue({ ...staged, status: "READY", document_id: "doc", version: 1 });
  await open(); fireEvent.change(screen.getByRole("combobox", { name: "Uploaded in this conversation" }), { target: { value: "upload" } });
  await screen.findByText("form.txt · Searchable");
  expect(screen.queryByRole("button", { name: "Use reviewed data for ERP workflow" })).toBeNull();
});
