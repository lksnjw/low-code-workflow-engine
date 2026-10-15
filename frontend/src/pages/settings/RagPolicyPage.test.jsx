/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import "@testing-library/jest-dom/jest-globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
const status = jest.fn(), testPolicy = jest.fn();
jest.unstable_mockModule("../../services/rag-policy.service", () => ({ ragPolicyService: { status, test: testPolicy } }));
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { default: Page } = await import("./RagPolicyPage");
const { policyDraftText, ragPolicySamples } = await import("./rag-policy-samples");
const data = { configured: true, state: "CONNECTED", health: { policy_collection: "policy_docs", policy_chunks: 21 }, switches: { remote: true }, actions: [{ name: "approve_invoice", description: "Approve invoices" }] };
const mount = () => render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Page /></QueryClientProvider></MemoryRouter>);
beforeEach(() => { status.mockReset().mockResolvedValue(data); testPolicy.mockReset(); });
afterEach(cleanup);
test("console separates connected service, supported actions and inactive drafts", async () => {
  mount(); expect(await screen.findByText("Connected directly through the backend")).toBeVisible();
  expect(screen.getByText(/Their wider prose is not automatically enforced/)).toBeVisible(); expect(screen.getAllByText("Draft · not enforced by RAG")).toHaveLength(2);
  expect(screen.getByRole("link", { name: "Policy switches" })).toHaveAttribute("href", "/settings");
  expect(screen.queryByLabelText(/key|token/i)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check policy" })).toBeDisabled();
});
test("policy check shows busy input protection and returns conditions, not execution", async () => {
  let finish; testPolicy.mockImplementation(() => new Promise(resolve => { finish = resolve; })); mount(); await screen.findByText("Connected directly through the backend");
  fireEvent.change(screen.getByLabelText("Question or proposed action"), { target: { value: "What checks are required?" } }); fireEvent.click(screen.getByRole("button", { name: "Check policy" }));
  expect(screen.getByLabelText("Question or proposed action")).toBeDisabled(); expect(screen.getByRole("button", { name: "Checking policy…" })).toBeDisabled();
  finish({ decision: "review", request_type: "action", reason: "Missing approval", conditions: [], citations: [], retrieval: { total_unique: 0 }, warning: "Evaluation only." });
  expect(await screen.findByText("Missing approval")).toBeVisible(); expect(screen.getByText(/No cited policy evidence/)).toBeVisible();
  expect(screen.getByText(/No ERP operation was performed/)).toBeVisible(); expect(testPolicy).toHaveBeenCalledTimes(1); expect(testPolicy).toHaveBeenCalledWith("What checks are required?");
});
test("failed test remains visible and does not retry", async () => {
  testPolicy.mockRejectedValue(new Error("Response was not confirmed")); mount(); await screen.findByText("Connected directly through the backend");
  fireEvent.click(screen.getByRole("button", { name: "Can I delete this customer record?" })); fireEvent.click(screen.getByRole("button", { name: "Check policy" }));
  await screen.findByRole("alert"); expect(testPolicy).toHaveBeenCalledTimes(1); expect(screen.queryByText(/review · action/)).toBeNull();
});
test("sample policy files identify themselves as unimported drafts", () => {
  for (const sample of ragPolicySamples) expect(policyDraftText(sample)).toContain("DRAFT — NOT IMPORTED OR ACTIVE");
  expect(policyDraftText(ragPolicySamples[0])).toContain("including administrators");
  expect(policyDraftText(ragPolicySamples[1])).toContain("Stop when any required value is missing");
});
test("unconfigured service disables testing", async () => {
  status.mockResolvedValue({ configured: false, state: "UNCONFIGURED" }); mount(); await screen.findByText("RAG connection needs attention");
  fireEvent.change(screen.getByLabelText("Question or proposed action"), { target: { value: "Read a policy" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Check policy" })).toBeDisabled());
});
