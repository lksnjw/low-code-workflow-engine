/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiClient } from "../../config/axios";
import { transitionAuthority } from "../../utils/authAuthority";
const user = {id: "paged-owner", role: "Operator", permissions: ["workflow:read_own"]};
jest.unstable_mockModule("../../context/AuthContext", () => ({useAuthContext: () => { transitionAuthority(user); return {user}; }}));
jest.unstable_mockModule("../../context/RouteContext", () => ({useRoute: () => ({openWorkflow: jest.fn(), startWorkflow: jest.fn()})}));
const {default: WorkflowListPage} = await import("./WorkflowListPage");
const clients = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); jest.restoreAllMocks(); });
test("loads only the requested 20-item workflow page and exposes accessible next/previous controls", async () => {
  const get = jest.spyOn(apiClient, "get").mockImplementation(async (_path, {params}) => ({data: {data: [{id: `page-${params.page}`, name: `Page ${params.page} reference`, owner: {name: "Owner"}, status: "PENDING"}], meta: {page: params.page, limit: 20, total: 45, totalPages: 3}}}));
  const client = new QueryClient({defaultOptions: {queries: {retry:false, gcTime:Infinity}}}); clients.push(client);
  render(<QueryClientProvider client={client}><WorkflowListPage /></QueryClientProvider>);
  await screen.findByRole("navigation", {name:"Workflow pages"});
  expect(get.mock.calls[0][1].params).toMatchObject({page:1,limit:20});
  expect(screen.getByRole("button", {name:"Previous"}).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", {name:"Next"}));
  await waitFor(() => expect(get.mock.calls.at(-1)[1].params.page).toBe(2));
  await screen.findByText(/Page 2 of 3/);
  fireEvent.click(screen.getByRole("button", {name:"Previous"})); await screen.findByText(/Page 1 of 3/);
});
