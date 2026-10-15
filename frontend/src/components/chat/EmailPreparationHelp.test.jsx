/** @jest-environment jsdom */
import React from "react";
import { jest, test, expect, afterEach } from "@jest/globals";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { registryService } from "../../services/registry.service";
import EmailPreparationHelp from "./EmailPreparationHelp";
import { emailSenderOptions } from "./emailSenderOptions";
const tool = { name: "provider-notify", inputSchema: { properties: { from: { type: "string", description: "Examples are support@sender.example and items@sender.example. Other local parts allowed." }, to: { type: "array" }, subject: { type: "string" }, text: { type: "string" } } } };
afterEach(() => { cleanup(); jest.restoreAllMocks(); });

test("sender options use current contract examples or enum, not invented app defaults", () => {
  expect(emailSenderOptions(tool)).toEqual({ choices: ["support@sender.example", "items@sender.example"], restricted: false });
  expect(emailSenderOptions({ ...tool, inputSchema: { properties: { ...tool.inputSchema.properties, from: { type: "string", enum: ["only@sender.example"], description: "obsolete@sender.example" } } } })).toEqual({ choices: ["only@sender.example"], restricted: true });
  expect(emailSenderOptions({ ...tool, annotations: { readOnlyHint: true } })).toBeNull();
});

test("loads dropdown on demand, requires user selection and continues clarification without sending", async () => {
  const live = jest.spyOn(registryService, "liveTools").mockImplementation(async args => args.toolName ? { tool } : { connectionId: "current", tools: [{ name: tool.name, effect: "CHANGE_OR_OTHER" }] });
  const onContinue = jest.fn().mockResolvedValue({});
  render(<EmailPreparationHelp onContinue={onContinue} />);
  expect(live).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Complete email details" }));
  const sender = await screen.findByLabelText("Choose sender address"); expect(sender.value).toBe("");
  expect(screen.getByRole("button", { name: "Continue preparing email" }).disabled).toBe(true);
  fireEvent.change(sender, { target: { value: "support@sender.example" } });
  fireEvent.change(screen.getByLabelText("Recipient email (optional clarification)"), { target: { value: "recipient@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue preparing email" }));
  await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
  expect(onContinue.mock.calls[0][0]).toContain("Use this exact sender address: support@sender.example");
  expect(onContinue.mock.calls[0][0]).toContain("Do not send, approve or retry");
  expect(screen.queryByRole("button", { name: /Confirm and send/ })).toBeNull();
});

test("unavailable catalog falls back to full email input and close does not submit", async () => {
  jest.spyOn(registryService, "liveTools").mockRejectedValue(new Error("no access"));
  const onContinue = jest.fn(); render(<EmailPreparationHelp onContinue={onContinue} />);
  fireEvent.click(screen.getByRole("button", { name: "Complete email details" }));
  await screen.findByText(/Sender choices could not be loaded/);
  expect(screen.getByLabelText("Full sender email").type).toBe("email");
  expect(screen.queryByLabelText("Choose sender address")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close details" })); expect(onContinue).not.toHaveBeenCalled();
});

test("send, schedule and attachment contracts share a dropdown without requiring a single connector", async () => {
  jest.spyOn(registryService, "liveTools").mockImplementation(async args => args.toolName ? { tool } : { connectionId: "current", tools: ["send", "schedule", "attach"].map(name => ({ name, effect: "CHANGE_OR_OTHER" })) });
  render(<EmailPreparationHelp onContinue={jest.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Complete email details" }));
  const sender = await screen.findByLabelText("Choose sender address"); expect(sender.value).toBe("");
  expect(screen.getAllByRole("option", { name: "support@sender.example" })).toHaveLength(1);
  expect(screen.queryByText(/could not be loaded/)).toBeNull();
});

test("unconfirmed chat response prevents duplicate clarification submits", async () => {
  jest.spyOn(registryService, "liveTools").mockRejectedValue(new Error("offline"));
  const onContinue = jest.fn().mockResolvedValue(null); render(<EmailPreparationHelp onContinue={onContinue} />);
  fireEvent.click(screen.getByRole("button", { name: "Complete email details" })); await screen.findByText(/Sender choices could not be loaded/);
  fireEvent.change(screen.getByLabelText("Full sender email"), { target: { value: "support@sender.example" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue preparing email" })); await screen.findByText(/acknowledgement is unconfirmed/);
  fireEvent.click(screen.getByRole("button", { name: "Continue preparing email" })); expect(onContinue).toHaveBeenCalledTimes(1);
});
