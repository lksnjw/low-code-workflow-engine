/** @jest-environment jsdom */

import { expect, jest, test } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import TraceIdentifier from "./TraceIdentifier";

test("renders and copies an actionable trace ID", async () => {
  const writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const traceId = "4dfac97d-52c4-4f29-b09b-e2f60f7c89dc";

  render(<TraceIdentifier traceId={traceId} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));

  expect(writeText).toHaveBeenCalledWith(traceId);
  expect(await screen.findByRole("button", { name: "Copied" })).not.toBeNull();
});
