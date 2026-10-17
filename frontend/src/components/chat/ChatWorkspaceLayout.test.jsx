/** @jest-environment jsdom */
import React, { createRef, useEffect, useState } from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import ChatWorkspaceLayout from "./ChatWorkspaceLayout";
import { useChatWorkspace } from "./ChatWorkspaceContext";

const storageKey = "workflow.workspace.qa.chat.layout./chat";
afterEach(() => { cleanup(); sessionStorage.clear(); jest.restoreAllMocks(); });

function mount(options = {}) {
  return render(<ChatWorkspaceLayout storageKey={storageKey} chat={<textarea aria-label="Message to workflow assistant" />} canvas={<button>Selected workflow node</button>} {...options} />);
}
const divider = () => screen.getByRole("separator", { name: "Resize chat and canvas" });
const openTools = () => {
  const toggle = screen.getByRole("button", { name: "Workspace tools", exact: true });
  if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
};
const mode = value => { openTools(); fireEvent.click(screen.getByRole("button", { name: value, exact: true })); };

test("opening a saved workflow from chat-only view restores the inline canvas without replacing chat", () => {
  const selected = jest.fn();
  function Open() { const workspace = useChatWorkspace(); return <button onClick={() => workspace.openWorkflow("saved")}>Open saved draft</button>; }
  mount({ onOpenWorkflow: selected, chat: <><textarea aria-label="Message to workflow assistant" /><Open /></> });
  const composer = screen.getByRole("textbox"); fireEvent.change(composer, { target: { value: "Keep my unsent question" } });
  mode("Chat only"); fireEvent.click(screen.getByRole("button", { name: "Open saved draft" }));
  expect(selected).toHaveBeenCalledWith("saved"); expect(screen.getByTestId("chat-workspace-layout").dataset.view).toBe("split");
  expect(screen.getByRole("textbox")).toBe(composer); expect(composer.value).toBe("Keep my unsent question");
});

test("starts with a bounded, keyboard-accessible splitter and two visible panes", () => {
  mount();
  expect(screen.getByTestId("chat-workspace-layout").dataset.view).toBe("split");
  expect(divider().getAttribute("aria-orientation")).toBe("vertical");
  expect(divider().getAttribute("aria-valuenow")).toBe("45");
  expect(divider().getAttribute("tabindex")).toBe("0");
  openTools();
  expect(screen.getByRole("button", { name: "Split view" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByTestId("workspace-chat-pane").hidden).toBe(false);
  expect(screen.getByTestId("workspace-canvas-pane").hidden).toBe(false);
});

test("selecting Split view enters focus with both panes and keeps that focus when chat opens a workflow", () => {
  const selected = jest.fn();
  function Open() { const workspace = useChatWorkspace(); return <button onClick={() => workspace.openWorkflow("saved")}>Open saved draft</button>; }
  mount({ onOpenWorkflow: selected, chat: <><textarea aria-label="Message to workflow assistant" /><Open /></> });
  const composer = screen.getByRole("textbox"); fireEvent.change(composer, { target: { value: "Keep analysis question" } });
  mode("Split view");
  expect(screen.getByTestId("chat-workspace-layout").dataset.fullScreen).toBe("true");
  expect(screen.getByTestId("workspace-chat-pane").hidden).toBe(false); expect(screen.getByTestId("workspace-canvas-pane").hidden).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Open saved draft" }));
  expect(selected).toHaveBeenCalledWith("saved"); expect(screen.getByTestId("chat-workspace-layout").dataset.view).toBe("split");
  expect(screen.getByTestId("chat-workspace-layout").dataset.fullScreen).toBe("true"); expect(composer.value).toBe("Keep analysis question");
});

test.each(["Chat only", "Canvas only"])("%s hides only the other pane and Split view restores it", view => {
  mount(); mode(view);
  expect(screen.getByTestId("workspace-chat-pane").hidden).toBe(view === "Canvas only");
  expect(screen.getByTestId("workspace-canvas-pane").hidden).toBe(view === "Chat only");
  expect(screen.queryByRole("separator")).toBeNull();
  mode("Split view");
  expect(screen.getByTestId("workspace-chat-pane").hidden).toBe(false);
  expect(screen.getByTestId("workspace-canvas-pane").hidden).toBe(false);
  expect(divider()).toBeTruthy();
});

test("view switches keep child component identity, unsent text and pending canvas edits", () => {
  const unmount = jest.fn();
  function Pane({ label }) {
    const [value, setValue] = useState("");
    useEffect(() => () => unmount(label), []);
    return <input aria-label={label} value={value} onChange={event => setValue(event.target.value)} />;
  }
  mount({ chat: <Pane label="Unsent message" />, canvas: <Pane label="Pending canvas edit" /> });
  const chat = screen.getByLabelText("Unsent message"), canvas = screen.getByLabelText("Pending canvas edit");
  fireEvent.change(chat, { target: { value: "Keep my question" } });
  fireEvent.change(canvas, { target: { value: "Keep my preview" } });
  mode("Canvas only"); mode("Chat only"); mode("Split view");
  expect(screen.getByLabelText("Unsent message")).toBe(chat);
  expect(screen.getByLabelText("Pending canvas edit")).toBe(canvas);
  expect(chat.value).toBe("Keep my question"); expect(canvas.value).toBe("Keep my preview");
  expect(unmount).not.toHaveBeenCalled();
});

test("arrow keys resize in small or Shift-accelerated steps and other keys are ignored", () => {
  mount();
  fireEvent.keyDown(divider(), { key: "ArrowRight" });
  expect(divider().getAttribute("aria-valuenow")).toBe("47");
  fireEvent.keyDown(divider(), { key: "ArrowRight", shiftKey: true });
  expect(divider().getAttribute("aria-valuenow")).toBe("57");
  fireEvent.keyDown(divider(), { key: "ArrowLeft" });
  expect(divider().getAttribute("aria-valuenow")).toBe("55");
  fireEvent.keyDown(divider(), { key: "x" });
  expect(divider().getAttribute("aria-valuenow")).toBe("55");
});

test("Home and End enforce pane limits; Enter and double-click reset the split", () => {
  mount();
  fireEvent.keyDown(divider(), { key: "Home" });
  expect(divider().getAttribute("aria-valuenow")).toBe(divider().getAttribute("aria-valuemin"));
  fireEvent.keyDown(divider(), { key: "ArrowLeft" });
  expect(divider().getAttribute("aria-valuenow")).toBe(divider().getAttribute("aria-valuemin"));
  fireEvent.keyDown(divider(), { key: "End" });
  expect(divider().getAttribute("aria-valuenow")).toBe(divider().getAttribute("aria-valuemax"));
  fireEvent.keyDown(divider(), { key: "ArrowRight" });
  expect(divider().getAttribute("aria-valuenow")).toBe(divider().getAttribute("aria-valuemax"));
  fireEvent.keyDown(divider(), { key: "Enter" });
  expect(divider().getAttribute("aria-valuenow")).toBe("45");
  fireEvent.keyDown(divider(), { key: "ArrowRight" }); fireEvent.doubleClick(divider());
  expect(divider().getAttribute("aria-valuenow")).toBe("45");
});

test("Reset layout restores both panes and default widths, not their content", () => {
  mount(); fireEvent.keyDown(divider(), { key: "End" }); mode("Canvas only");
  fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
  expect(screen.getByTestId("chat-workspace-layout").dataset.view).toBe("split");
  expect(divider().getAttribute("aria-valuenow")).toBe("45");
});

test("layout preferences restore after remount and remain scoped to the supplied account key", () => {
  const view = mount(); fireEvent.keyDown(divider(), { key: "ArrowRight", shiftKey: true }); mode("Chat only");
  expect(JSON.parse(sessionStorage.getItem(storageKey))).toEqual({ ratio: 55, mode: "chat" });
  view.unmount(); const restored = mount();
  expect(screen.getByTestId("chat-workspace-layout").dataset.view).toBe("chat");
  mode("Split view"); expect(divider().getAttribute("aria-valuenow")).toBe("55");
  restored.unmount(); mount({ storageKey: "workflow.workspace.another.chat.layout./chat" });
  expect(screen.getByTestId("chat-workspace-layout").dataset.view).toBe("split");
  expect(divider().getAttribute("aria-valuenow")).toBe("45");
});

test.each(["not json", "null", '{"mode":"both-hidden","ratio":-500}', '{"mode":{},"ratio":"70"}'])("invalid saved layout is harmless: %s", saved => {
  sessionStorage.setItem(storageKey, saved); mount();
  expect(screen.getByTestId("chat-workspace-layout").dataset.view).toBe("split");
  expect(divider().getAttribute("aria-valuenow")).toBe("45");
});

test("indexed chat keeps its existing single-pane presentation without layout controls", () => {
  sessionStorage.setItem(storageKey, JSON.stringify({ mode: "canvas", ratio: 60 }));
  mount({ showCanvas: false });
  expect(screen.getByTestId("workspace-chat-pane").hidden).toBe(false);
  expect(screen.queryByTestId("workspace-canvas-pane")).toBeNull();
  expect(screen.queryByRole("group", { name: "Workspace view" })).toBeNull();
  expect(screen.queryByRole("separator")).toBeNull();
});

test("canvas requests can open the floating chat and focus the same composer without leaving canvas mode", () => {
  const ref = createRef();
  let nextFrame;
  jest.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { nextFrame = callback; return 0; });
  mount({ ref }); const composer = screen.getByRole("textbox", { name: "Message to workflow assistant" });
  mode("Canvas only");
  act(() => ref.current.focusChat());
  act(() => nextFrame());
  expect(screen.getByTestId("chat-workspace-layout").dataset.view).toBe("canvas");
  expect(screen.getByRole("dialog", { name: "Floating chat" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Message to workflow assistant" })).toBe(composer);
  expect(document.activeElement).toBe(composer);
});

test("floating chat opens, minimizes, reopens and expands without remounting its composer", () => {
  mount();
  const composer = screen.getByRole("textbox", { name: "Message to workflow assistant" });
  fireEvent.change(composer, { target: { value: "Unsent floating draft" } });
  mode("Canvas only");
  fireEvent.click(screen.getByRole("button", { name: "Open floating chat" }));
  expect(screen.getByRole("dialog", { name: "Floating chat" }).getAttribute("aria-modal")).toBe("false");
  expect(screen.getByTestId("workspace-canvas-pane").hidden).toBe(false);
  expect(screen.getByRole("textbox", { name: "Message to workflow assistant" })).toBe(composer);
  fireEvent.click(screen.getByRole("button", { name: "Minimize floating chat" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Open floating chat" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open floating chat" }));
  expect(composer.value).toBe("Unsent floating draft");
  fireEvent.click(screen.getByRole("button", { name: "Expand floating chat" }));
  expect(screen.getByTestId("chat-workspace-layout").dataset.view).toBe("chat");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Message to workflow assistant" })).toBe(composer);
  expect(composer.value).toBe("Unsent floating draft");
});

test("Escape minimizes only the floating chat; the split view can still be restored", () => {
  mount(); mode("Canvas only"); fireEvent.click(screen.getByRole("button", { name: "Open floating chat" }));
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Message to workflow assistant" }), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByTestId("chat-workspace-layout").dataset.view).toBe("canvas");
  mode("Split view"); expect(divider()).toBeTruthy();
});

test("storage being unavailable does not prevent resizing or restoring a pane", () => {
  jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage disabled"); });
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage disabled"); });
  mount(); fireEvent.keyDown(divider(), { key: "ArrowRight" }); mode("Chat only"); mode("Split view");
  expect(divider().getAttribute("aria-valuenow")).toBe("47");
});

function pointer(target, type, { pointerId = 1, isPrimary = true, ...options } = {}) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, ...options });
  Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: isPrimary } });
  fireEvent(target, event);
}

test("captured pointer dragging resizes, clamps, and stops on release without selecting text", () => {
  mount(); const handle = divider(), container = screen.getByTestId("workspace-chat-pane").parentElement;
  jest.spyOn(container, "getBoundingClientRect").mockReturnValue({ width: 1000 });
  handle.setPointerCapture = jest.fn(); handle.hasPointerCapture = jest.fn(() => true); handle.releasePointerCapture = jest.fn();
  pointer(handle, "pointerdown", { clientX: 450 });
  expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
  expect(container.className).toContain("select-none");
  pointer(handle, "pointermove", { clientX: 550 });
  expect(handle.getAttribute("aria-valuenow")).toBe("55");
  pointer(handle, "pointermove", { clientX: 100000 });
  expect(handle.getAttribute("aria-valuenow")).toBe(handle.getAttribute("aria-valuemax"));
  pointer(handle, "pointerup");
  expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
  expect(container.className).not.toContain("select-none");
  const ratio = handle.getAttribute("aria-valuenow");
  pointer(handle, "pointermove", { clientX: 400 }); expect(handle.getAttribute("aria-valuenow")).toBe(ratio);
});

test("secondary pointers and right clicks cannot start resizing; cancellation releases drag state", () => {
  mount(); const handle = divider(), container = screen.getByTestId("workspace-chat-pane").parentElement;
  jest.spyOn(container, "getBoundingClientRect").mockReturnValue({ width: 1000 });
  handle.setPointerCapture = jest.fn();
  pointer(handle, "pointerdown", { clientX: 400, button: 2 });
  pointer(handle, "pointerdown", { clientX: 400, isPrimary: false });
  expect(handle.setPointerCapture).not.toHaveBeenCalled();
  pointer(handle, "pointerdown", { clientX: 400 });
  pointer(handle, "pointermove", { clientX: 500, pointerId: 2 });
  expect(handle.getAttribute("aria-valuenow")).toBe("45");
  pointer(handle, "pointercancel");
  pointer(handle, "pointermove", { clientX: 600 });
  expect(handle.getAttribute("aria-valuenow")).toBe("45");
  expect(container.className).not.toContain("select-none");
});

test("container resizing protects minimum pane widths and restores the user's preferred split on growth", () => {
  sessionStorage.setItem(storageKey, JSON.stringify({ mode: "split", ratio: 70 }));
  const original = globalThis.ResizeObserver;
  let notify;
  const disconnect = jest.fn();
  globalThis.ResizeObserver = class {
    constructor(callback) { notify = callback; }
    observe() {}
    disconnect() { disconnect(); }
  };
  try {
    const view = mount();
    act(() => notify([{ contentRect: { width: 1300 } }]));
    expect(divider().getAttribute("aria-valuenow")).toBe("70");
    act(() => notify([{ contentRect: { width: 800 } }]));
    expect(divider().getAttribute("aria-valuenow")).toBe("59");
    expect(JSON.parse(sessionStorage.getItem(storageKey)).ratio).toBe(70);
    act(() => notify([{ contentRect: { width: 1300 } }]));
    expect(divider().getAttribute("aria-valuenow")).toBe("70");
    view.unmount(); expect(disconnect).toHaveBeenCalledTimes(1);
  } finally {
    if (original === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = original;
  }
});

test("tools are on the right, collapsed by default, and stay mounted when closed", () => {
  mount({ tools: <input aria-label="Private document review" defaultValue="Keep review" /> });
  expect(screen.queryByRole("complementary", { name: "Workspace tools" })).toBeNull();
  openTools();
  const panel = screen.getByRole("complementary", { name: "Workspace tools" });
  const review = screen.getByRole("textbox", { name: "Private document review" });
  expect(screen.getByTestId("workspace-chat-pane").compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.change(review, { target: { value: "Unfinished private review" } });
  fireEvent.click(screen.getByRole("button", { name: "Close workspace tools" }));
  expect(panel.hidden).toBe(true);
  openTools(); expect(screen.getByRole("textbox", { name: "Private document review" })).toBe(review);
  expect(review.value).toBe("Unfinished private review");
});

test.each(["Split view", "Canvas only", "Chat only"])("full screen expands the working surface and restores %s with its content", view => {
  mount();
  const composer = screen.getByRole("textbox", { name: "Message to workflow assistant" });
  fireEvent.change(composer, { target: { value: "Do not send this draft" } });
  mode(view);
  const previous = screen.getByTestId("chat-workspace-layout").dataset.view;
  const target = view === "Canvas only" ? "canvas" : view === "Split view" ? "split view" : "chat";
  if (view === "Split view") fireEvent.click(screen.getByRole("button", { name: "Exit full screen split view", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: `Full screen ${target}`, exact: true }));
  expect(screen.getByTestId("chat-workspace-layout").dataset.fullScreen).toBe("true");
  expect(screen.getByTestId("chat-workspace-layout").dataset.view).toBe(view === "Split view" ? "split" : target);
  expect(screen.queryByRole("complementary", { name: "Workspace tools" })).toBeNull();
  expect(document.body.style.overflow).toBe("hidden");
  expect(screen.getByRole("textbox", { name: "Message to workflow assistant", hidden: true })).toBe(composer);
  fireEvent.click(screen.getByRole("button", { name: `Exit full screen ${target}` }));
  expect(screen.getByTestId("chat-workspace-layout").dataset.view).toBe(previous);
  expect(composer.value).toBe("Do not send this draft");
  expect(document.body.style.overflow).toBe("");
});

test("Escape closes tools first, then leaves full screen without modifying saved layout", () => {
  mount();
  const saved = sessionStorage.getItem(storageKey);
  fireEvent.click(screen.getByRole("button", { name: "Full screen split view" }));
  openTools();
  fireEvent.keyDown(screen.getByRole("button", { name: "Close workspace tools" }), { key: "Escape" });
  expect(screen.queryByRole("complementary", { name: "Workspace tools" })).toBeNull();
  expect(screen.getByTestId("chat-workspace-layout").dataset.fullScreen).toBe("true");
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Message to workflow assistant" }), { key: "Escape" });
  expect(screen.getByTestId("chat-workspace-layout").dataset.fullScreen).toBe("false");
  expect(sessionStorage.getItem(storageKey)).toBe(saved);
});

test("full screen hides covered chrome and restores original visibility/inert/scroll settings on unmount", () => {
  document.body.style.overflow = "clip";
  const view = render(<div><nav style={{ visibility: "visible" }}>Covered navigation</nav><ChatWorkspaceLayout showCanvas={false} chat={<p>Conversation</p>} /></div>);
  const nav = screen.getByRole("navigation"); nav.inert = false;
  fireEvent.click(screen.getByRole("button", { name: "Full screen chat" }));
  expect(nav.inert).toBe(true); expect(nav.style.visibility).toBe("hidden");
  view.unmount();
  expect(nav.inert).toBe(false); expect(nav.style.visibility).toBe("visible");
  expect(document.body.style.overflow).toBe("clip"); document.body.style.overflow = "";
});
