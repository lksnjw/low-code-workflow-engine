/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import "@testing-library/jest-dom/jest-globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
const search = jest.fn(), resolve = jest.fn(); let user;
jest.unstable_mockModule("../../services/document-workspace.service", () => ({ documentWorkspaceService: { search, resolve } }));
jest.unstable_mockModule("../../context/AuthContext", () => ({ useAuthContext: () => ({ user }) }));
const { default: Page } = await import("./PipelineSearchPage");
const mount = () => render(<MemoryRouter><Page /></MemoryRouter>);
beforeEach(() => { user = { id: "owner", permissions: ["chat:use"] }; search.mockReset(); resolve.mockReset(); }); afterEach(cleanup);
test("search is explicit, bounded, and document content is fetched only on open", async () => {
  search.mockResolvedValue({ items: [{ document_id: "doc-one", source_system_id: "erpnext", source_entity: "Customer", document_type: "registration_form", version: 1 }], collections_searched: 1 });
  resolve.mockResolvedValue({ filename: "registration.png", form_fields: { customer_name: "Lakeview Office Supplies" }, text: "Stored source text" });
  mount(); expect(search).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Name, reference or document details"), { target: { value: "  Lakeview  " } }); fireEvent.click(screen.getByRole("button", { name: "Search documents" }));
  await screen.findByRole("button", { name: "Open document" }); expect(search).toHaveBeenCalledWith("Lakeview"); expect(resolve).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open document" })); expect(await screen.findByText("Lakeview Office Supplies")).toBeVisible(); expect(resolve).toHaveBeenCalledWith("doc-one");
});
test("empty search and unavailable retrieval are not false success", async () => {
  search.mockResolvedValue({ items: [], collections_searched: 0 }); mount(); fireEvent.change(screen.getByLabelText("Name, reference or document details"), { target: { value: "Missing" } }); fireEvent.click(screen.getByRole("button", { name: "Search documents" }));
  expect(await screen.findByText(/No permitted current document matched/)).toBeVisible();
  search.mockRejectedValue(new Error("Pipeline unavailable")); fireEvent.click(screen.getByRole("button", { name: "Search documents" })); expect(await screen.findByRole("alert")).toHaveTextContent("Pipeline unavailable");
});
test("an account change clears private matches", async () => {
  search.mockResolvedValue({ items: [{ document_id: "private", source_system_id: "hr", source_entity: "Employee" }] }); const view = mount();
  fireEvent.change(screen.getByLabelText("Name, reference or document details"), { target: { value: "Private" } }); fireEvent.click(screen.getByRole("button", { name: "Search documents" })); await screen.findByRole("button", { name: "Open document" });
  user = { ...user, id: "other" }; view.rerender(<MemoryRouter><Page /></MemoryRouter>); expect(screen.queryByRole("button", { name: "Open document" })).toBeNull();
});
