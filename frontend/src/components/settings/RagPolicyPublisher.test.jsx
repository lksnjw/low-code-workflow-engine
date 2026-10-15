/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import "@testing-library/jest-dom/jest-globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
const publish = jest.fn(), status = jest.fn();
jest.unstable_mockModule("../../services/rag-policy.service", () => ({ ragPolicyService: { publish, status } }));
const { default: Publisher } = await import("./RagPolicyPublisher");
beforeEach(() => { publish.mockReset(); status.mockReset(); }); afterEach(cleanup);
test("unavailable policy administration cannot publish", () => {
  render(<Publisher available={false} />);
  expect(screen.getAllByRole("button", { name: "Review rule" }).every(button => button.disabled)).toBe(true);
  expect(screen.queryByRole("button", { name: /delete|replace/i })).toBeNull();
});
test("publication needs exact review and a changed rule clears confirmation", () => {
  render(<Publisher available />); fireEvent.click(screen.getAllByRole("button", { name: "Review rule" })[0]);
  expect(screen.getByRole("button", { name: "Publish reviewed policy" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox")); expect(screen.getByRole("button", { name: "Publish reviewed policy" })).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Reviewed customer rules" } });
  expect(screen.getByRole("checkbox")).not.toBeChecked(); expect(publish).not.toHaveBeenCalled();
});
test("confirmed policy publishes once and reports only the confirmed receipt", async () => {
  let finish; publish.mockImplementation(() => new Promise(resolve => { finish = resolve; })); const refresh = jest.fn();
  render(<Publisher available onPublished={refresh} />); fireEvent.click(screen.getAllByRole("button", { name: "Review rule" })[0]); fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.submit(screen.getByRole("form", { name: "Review policy publication" })); fireEvent.submit(screen.getByRole("form", { name: "Review policy publication" }));
  expect(publish).toHaveBeenCalledTimes(1); expect(screen.getByRole("button", { name: "Publishing policy…" })).toBeDisabled();
  finish({ status: "INDEXED", policy_id: "ERP-CUSTOMER-REQUIRED-001", version: "1.0" });
  expect(await screen.findByText(/Indexed · ERP-CUSTOMER-REQUIRED-001/)).toBeVisible(); expect(refresh).toHaveBeenCalledTimes(1);
});
test("unconfirmed result locks publication instead of automatically retrying", async () => {
  publish.mockRejectedValue(new Error("Outcome unconfirmed")); render(<Publisher available />);
  fireEvent.click(screen.getAllByRole("button", { name: "Review rule" })[0]); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Publish reviewed policy" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Outcome unconfirmed"); expect(screen.getByRole("button", { name: "Publish reviewed policy" })).toBeDisabled(); expect(publish).toHaveBeenCalledTimes(1);
});
test("an uncertain publication is resolved by exact readback, never a second write", async () => {
  publish.mockRejectedValue(new Error("Response unconfirmed")); status.mockImplementation(async () => ({ policies: [publish.mock.calls[0][0]] }));
  render(<Publisher available />); fireEvent.click(screen.getAllByRole("button", { name: "Review rule" })[0]); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Publish reviewed policy" }));
  fireEvent.click(await screen.findByRole("button", { name: "Check publication status" }));
  expect(await screen.findByText(/Indexed · ERP-CUSTOMER-REQUIRED-001/)).toBeVisible(); expect(publish).toHaveBeenCalledTimes(1); expect(status).toHaveBeenCalledTimes(1);
});
