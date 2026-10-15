/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import WorkflowDialog from "./WorkflowDialog";

afterEach(() => cleanup());

test("popup traps keyboard focus, covers background controls and restores the opener on close", () => {
  const onClose = jest.fn();
  const view = render(<><button>Opener</button><WorkflowDialog open={false} title="Run inputs" onClose={onClose}><input aria-label="Customer" /><button>Start</button></WorkflowDialog></>);
  const opener = screen.getByRole("button", { name: "Opener" }); opener.focus();
  view.rerender(<><button>Opener</button><WorkflowDialog open title="Run inputs" onClose={onClose}><input aria-label="Customer" /><button>Start</button></WorkflowDialog></>);
  const dialog = screen.getByRole("dialog", { name: "Run inputs" }); expect(document.activeElement).toBe(dialog); expect(view.container.inert).toBe(true);
  const first = screen.getByRole("button", { name: "Close Run inputs" }), last = screen.getByRole("button", { name: "Start" });
  fireEvent.keyDown(dialog, { key: "Tab" }); expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: "Tab" }); expect(document.activeElement).toBe(first);
  fireEvent.keyDown(dialog, { key: "Escape" }); expect(onClose).toHaveBeenCalledTimes(1);
  view.rerender(<><button>Opener</button><WorkflowDialog open={false} title="Run inputs" onClose={onClose} /></>);
  expect(view.container.inert).not.toBe(true); expect(document.activeElement).toBe(opener); expect(document.body.style.overflow).not.toBe("hidden");
});

test("busy popup cannot be accidentally closed with Escape or its close control", () => {
  const close = jest.fn(); render(<WorkflowDialog open busy title="Starting run" onClose={close}><p>Starting</p></WorkflowDialog>);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }); fireEvent.click(screen.getByRole("button", { name: "Close Starting run" }));
  expect(close).not.toHaveBeenCalled(); expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("true");
});
