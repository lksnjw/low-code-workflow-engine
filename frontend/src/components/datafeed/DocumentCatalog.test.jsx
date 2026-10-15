/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import "@testing-library/jest-dom/jest-globals";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const catalog = jest.fn(), inventory = jest.fn(), importSchema = jest.fn(), migrate = jest.fn();
let user;
jest.unstable_mockModule("../../context/AuthContext", () => ({ useAuthContext: () => ({ user }) }));
jest.unstable_mockModule("../../services/document-workspace.service", () => ({ documentWorkspaceService: { catalog, inventory, importSchema, migrate } }));
const { default: DocumentCatalog } = await import("./DocumentCatalog");
const schema = { id: "schema-one", source_system_id: "hr", source_entity: "members", primary_key: "member_id", revision: 4,
  fields: [{ name: "name", type: "string" }], document_types: ["registration_form"], reader_roles: [], minimum_sensitivity: "confidential" };
const summary = { searchable_documents: 3, pending_review: 2, index_failed: 0, counts_complete: false, as_of: "2026-10-15T12:00:00Z" };
beforeEach(() => {
  [catalog, inventory, importSchema, migrate].forEach(mock => mock.mockReset());
  user = { id: "admin", role: "Platform Admin", permissions: ["registry:write", "pipeline:upload"] };
  catalog.mockResolvedValue({ entities: [schema] }); inventory.mockResolvedValue(summary); importSchema.mockResolvedValue({});
});
afterEach(cleanup);

test("collection catalog shows purpose, permission-scoped counts and freshness without raw contents", async () => {
  catalog.mockResolvedValue({ entities: [], as_of: summary.as_of, counts_complete: true, legacy_current_documents: 1, collections: [{ collection: "erp_lib_v1_hr_members_restricted_hash", source_system_id: "hr", source_entity: "members", tier: "restricted", document_types: ["medical_certificate"], searchable_documents: 2, description: "Restricted, owner-only documents", document_type_counts: { medical_certificate: 2 } }] });
  render(<DocumentCatalog />);
  const section = await screen.findByRole("region", { name: "Schema collection destinations" });
  expect(section).toHaveTextContent("medical_certificate"); expect(section).toHaveTextContent("Restricted · owner only"); expect(section).toHaveTextContent("erp_lib_v1_hr_members_restricted_hash");
  expect(section).toHaveTextContent("previous private collection"); expect(section).toHaveTextContent("as of");
});

test("legacy migration requires explicit confirmation and forwards document revision, not a collection name", async () => {
  inventory.mockResolvedValue({ ...summary, legacy_current_documents: 1, documents: [{ id: "doc", revision: 5, owner_id: "admin", current_upload_id: "upload", source_system_id: "hr", source_entity: "members", document_type: "registration_form", version: 2 }] });
  migrate.mockResolvedValue({ status: "MIGRATED", deleted_vectors: 0 });
  render(<DocumentCatalog />); await screen.findByText("hr / members");
  fireEvent.click(screen.getByText("Migrate an owned document to its schema collection"));
  fireEvent.change(screen.getByLabelText("Legacy document to migrate"), { target: { value: "doc" } });
  const button = screen.getByRole("button", { name: "Reindex & move collection" }); expect(button).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this collection move/ })); fireEvent.click(button);
  await waitFor(() => expect(migrate).toHaveBeenCalledWith({ document_id: "doc", expected_revision: 5, review_confirmed: true }));
  expect(await screen.findByText(/Collection move confirmed/)).toHaveTextContent("no old vectors deleted");
});

test("shows bounded inventory honestly and preserves the selected schema revision on save", async () => {
  render(<DocumentCatalog />);
  expect(await screen.findByText("hr / members")).toBeTruthy();
  expect(screen.getByText(/Bounded sample/)).toHaveTextContent("3 searchable");
  fireEvent.click(screen.getByRole("button", { name: "Edit schema" }));
  const input = screen.getByLabelText("Entity schema JSON");
  expect(JSON.parse(input.value)).toMatchObject({ expected_revision: 4, source_entity: "members" });
  expect(input.closest("details")).toHaveAttribute("open");
  fireEvent.click(screen.getByRole("button", { name: "Save entity schema" }));
  await waitFor(() => expect(importSchema).toHaveBeenCalledWith(expect.objectContaining({ expected_revision: 4 })));
  expect(await screen.findByText(/Entity schema saved/)).toHaveTextContent("No original ERP records were created");
});

test("schema changes are hidden for users without registry permission", async () => {
  user = { id: "member", role: "Client", permissions: ["pipeline:upload"] };
  render(<DocumentCatalog />); await screen.findByText("hr / members");
  expect(screen.queryByText("Import or update an entity schema")).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit schema" })).toBeNull();
});

test("an account transition clears old inventory and ignores delayed old-account responses", async () => {
  let finishOld;
  catalog.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  const view = render(<DocumentCatalog />);
  user = { id: "new-member", role: "Client", permissions: ["pipeline:upload"] };
  catalog.mockResolvedValue({ entities: [] }); inventory.mockResolvedValue({ ...summary, searchable_documents: 0, counts_complete: true });
  view.rerender(<DocumentCatalog />);
  await screen.findByText(/0 searchable/);
  await act(async () => { finishOld({ entities: [schema] }); });
  expect(screen.queryByText("hr / members")).toBeNull();
  expect(screen.queryByText(/3 searchable/)).toBeNull();
  expect(screen.queryByLabelText("Entity schema JSON")).toBeNull();
});

test("invalid schema JSON never reaches the API and refresh failures are visible", async () => {
  render(<DocumentCatalog />); await screen.findByText("hr / members");
  const input = screen.getByLabelText("Entity schema JSON"); input.closest("details").open = true;
  fireEvent.change(input, { target: { value: "{invalid" } });
  fireEvent.click(screen.getByRole("button", { name: "Save entity schema" }));
  await screen.findByRole("alert"); expect(importSchema).not.toHaveBeenCalled();
  catalog.mockRejectedValueOnce(new Error("Pipeline unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh inventory" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Pipeline unavailable");
});
