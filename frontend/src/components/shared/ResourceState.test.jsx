/** @jest-environment jsdom */

import { afterEach, expect, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { ErrorState } from "./ResourceState.jsx";

afterEach(cleanup);

test("ErrorState renders a backend error message", () => {
  render(
    <ErrorState
      error={{ response: { data: { message: "You do not have permission to view this data." } } }}
    />,
  );

  expect(screen.getByText("You do not have permission to view this data.")).not.toBeNull();
});

test("ErrorState renders the generic fallback without a backend message", () => {
  render(<ErrorState error={new Error("Network Error")} />);

  expect(
    screen.getByText("The requested data is unavailable. Try again or reload this screen."),
  ).not.toBeNull();
});
