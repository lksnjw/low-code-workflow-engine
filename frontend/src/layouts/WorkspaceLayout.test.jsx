/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { workspaceKey, readWorkspaceValue } from "../utils/workspaceSession";

let grants = ["chat:use", "workflow:read_own"];
jest.unstable_mockModule("../context/AuthContext", () => ({ useAuthContext: () => ({ user: { id: "qa-layout" } }) }));
jest.unstable_mockModule("../hooks/usePermissions", () => ({ default: () => ({ hasAny: required => required.some(permission => grants.includes(permission)) }) }));
jest.unstable_mockModule("../components/navigation/Sidebar", () => ({ default: ({ isCollapsed, onToggle }) => <aside aria-label="Shared sidebar"><button onClick={onToggle}>{isCollapsed ? "Expand sidebar" : "Collapse sidebar"}</button></aside> }));
jest.unstable_mockModule("../components/navigation/Topbar", () => ({ default: () => <header>Shared topbar</header> }));
jest.unstable_mockModule("../components/navigation/MobileNav", () => ({ default: () => <nav aria-label="Shared mobile navigation" /> }));
jest.unstable_mockModule("../components/shared/ServerUnreachableBanner", () => ({ default: () => null }));
const { default: WorkspaceLayout } = await import("./WorkspaceLayout");

afterEach(() => { cleanup(); sessionStorage.clear(); grants = ["chat:use", "workflow:read_own"]; });

test.each(["/", "/chat", "/chat/session-1?mode=edit"])("chat uses shared left sidebar before the working surface at %s", path => {
  render(<MemoryRouter initialEntries={[path]}><WorkspaceLayout><p>Chat and canvas</p></WorkspaceLayout></MemoryRouter>);
  const sidebar = screen.getByRole("complementary", { name: "Shared sidebar" }), main = screen.getByRole("main");
  expect(sidebar.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText("Shared topbar")).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "Shared mobile navigation" })).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "Workspace navigation" })).toBeNull();
  expect(readWorkspaceValue(workspaceKey({ id: "qa-layout" }, "return"))).toBe(path);
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
  expect(screen.getByText("Chat and canvas")).toBeTruthy();
});

test.each(["workflow:read", "workflow:read_own", "execution:read_own", "chat:use"])("workspace has no extra dashboard row above the conversation for %s", permission => {
  grants = [permission];
  render(<MemoryRouter><WorkspaceLayout><p>Chat</p></WorkspaceLayout></MemoryRouter>);
  expect(screen.queryByRole("navigation", { name: "Workspace shortcuts" })).toBeNull();
  // Dashboard now belongs to the shared left sidebar (tested separately).
  expect(screen.queryByRole("link", { name: "Dashboard", exact: true })).toBeNull();
});
