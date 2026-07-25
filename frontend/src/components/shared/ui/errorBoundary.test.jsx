/** @jest-environment jsdom */

import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import ErrorBoundary from "./ErrorBoundary";

function ThrowingRoute() {
  throw new Error("render failed");
}

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

test("errorBoundary.test", () => {
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  render(
    <ErrorBoundary name="execution detail">
      <ThrowingRoute />
    </ErrorBoundary>
  );

  expect(screen.getByRole("alert").textContent).toContain("Could not render execution detail");
  expect(screen.getByRole("button", { name: "Reload application" })).not.toBeNull();
});
