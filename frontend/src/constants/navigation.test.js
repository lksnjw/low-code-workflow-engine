import { expect, test } from "@jest/globals";
import { NAVIGATION_GROUPS, filterNavigationGroups, resolvePermittedRoute } from "./navigation.js";

const allow = (permissions) => (required) =>
  required.some((permission) => permissions.includes(permission));

test("admin navigation shows every group", () => {
  const permissions = [
    "workflow:read",
    "workflow:write",
    "workflow:run",
    "settings:manage",
    "provider:manage",
    "registry:read",
    "registry:write",
    "user:manage",
    "audit:read",
  ];

  const visible = filterNavigationGroups(NAVIGATION_GROUPS, allow(permissions), "role_admin");
  expect(visible.map((group) => group.id)).toEqual(
    NAVIGATION_GROUPS.map((group) => group.id)
  );
});

test("system admin navigation excludes providers and platform settings but includes read-only registry", () => {
  const permissions = ["user:manage", "registry:read", "audit:read"];
  const visible = filterNavigationGroups(NAVIGATION_GROUPS, allow(permissions), "role_system_admin");
  expect(visible.map((group) => group.id).sort()).toEqual(["profile", "registry", "users"].sort());
});

test("client navigation contains only chat, owned workflows and executions, and profile", () => {
  const permissions = [
    "chat:use",
    "workflow:read_own",
    "workflow:run_own",
    "execution:read_own",
  ];

  const visible = filterNavigationGroups(NAVIGATION_GROUPS, allow(permissions), "role_client");
  expect(visible.map((group) => group.label).sort()).toEqual(
    ["Chat", "My Workflows", "My Executions", "Profile"].sort()
  );
});

test("client dashboard request falls back to the first permitted portal route", () => {
  const permissions = [
    "chat:use",
    "workflow:read_own",
    "workflow:run_own",
    "execution:read_own",
  ];

  expect(
    resolvePermittedRoute(
      NAVIGATION_GROUPS,
      allow(permissions),
      "role_client",
      { main: "dashboard", sub: "overview" }
    )
  ).toEqual({ main: "workflows", sub: "list" });
});
