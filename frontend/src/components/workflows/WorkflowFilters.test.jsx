/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import WorkflowFilters from "./WorkflowFilters";
afterEach(cleanup);
test("workflow data filters have names distinct from sidebar navigation search", () => {
  const onQueryChange = jest.fn(), onStatusChange = jest.fn();
  render(<WorkflowFilters query="" status="" onQueryChange={onQueryChange} onStatusChange={onStatusChange} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Search saved workflows" }), { target: { value: "invoice" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Workflow status filter" }), { target: { value: "PUBLISHED" } });
  expect(onQueryChange).toHaveBeenCalledWith("invoice"); expect(onStatusChange).toHaveBeenCalledWith("PUBLISHED");
});
