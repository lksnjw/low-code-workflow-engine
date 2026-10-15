/** @jest-environment jsdom */
import { afterEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NotificationProvider, useNotifications } from "./NotificationContext";
afterEach(()=>{cleanup();jest.useRealTimers();});
function Controls(){const {notify,activity,markActivityRead}=useNotifications();return <><button onClick={()=>notify("Workflow saved","success")}>Save</button><button onClick={()=>notify("Request failed; draft retained","error")}>Fail</button><button onClick={()=>markActivityRead()}>Read</button><pre aria-label="Activity">{JSON.stringify(activity)}</pre></>;}
test("toast dismissal keeps readable activity and errors have an alert",()=>{render(<NotificationProvider><Controls/></NotificationProvider>);fireEvent.click(screen.getByText("Save"));expect(screen.getByRole("status").textContent).toContain("Workflow saved");fireEvent.click(screen.getByRole("button",{name:"Dismiss notification"}));expect(screen.queryByRole("status")).toBeNull();expect(JSON.parse(screen.getByLabelText("Activity").textContent)[0].read).toBe(false);fireEvent.click(screen.getByText("Read"));expect(JSON.parse(screen.getByLabelText("Activity").textContent)[0].read).toBe(true);fireEvent.click(screen.getByText("Fail"));expect(screen.getByRole("alert").textContent).toContain("draft retained");});
test("unmount clears notification timers, and an account-key change clears activity",()=>{jest.useFakeTimers();const view=render(<NotificationProvider key="one"><Controls/></NotificationProvider>);fireEvent.click(screen.getByText("Save"));expect(jest.getTimerCount()).toBe(1);view.rerender(<NotificationProvider key="two"><Controls/></NotificationProvider>);expect(jest.getTimerCount()).toBe(0);expect(screen.getByLabelText("Activity").textContent).toBe("[]");view.unmount();});
test("automatic toast expiry does not erase the recent-activity message",()=>{jest.useFakeTimers();render(<NotificationProvider><Controls/></NotificationProvider>);fireEvent.click(screen.getByText("Save"));act(()=>jest.advanceTimersByTime(6001));expect(screen.queryByRole("status")).toBeNull();expect(screen.getByLabelText("Activity").textContent).toContain("Workflow saved");});

function ActionControls({ action }) { const { notify } = useNotifications(); return <button onClick={() => notify("Review needed", "info", { label: "Open review", onClick: action })}>Notify action</button>; }
test("an actionable notification remains until acknowledged instead of losing its button on a timer", () => {
  jest.useFakeTimers(); render(<NotificationProvider><ActionControls action={jest.fn()} /></NotificationProvider>);
  fireEvent.click(screen.getByText("Notify action")); act(() => jest.advanceTimersByTime(20000));
  expect(screen.getByRole("button", { name: "Open review" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Dismiss notification" }).textContent).toBe("OK");
});
test("failed asynchronous popup actions remain visible and a double click cannot submit twice", async () => {
  let finish; const action = jest.fn(() => new Promise((_, reject) => { finish = reject; }));
  render(<NotificationProvider><ActionControls action={action} /></NotificationProvider>);
  fireEvent.click(screen.getByText("Notify action")); const button = screen.getByRole("button", { name: "Open review" });
  fireEvent.click(button); fireEvent.click(button); expect(action).toHaveBeenCalledTimes(1);
  await act(async () => finish(new Error("Offline")));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Action was not confirmed/));
  expect(screen.getByRole("button", { name: "Open review" })).toBeTruthy(); expect(action).toHaveBeenCalledTimes(1);
});
