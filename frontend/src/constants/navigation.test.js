import { expect, test } from "@jest/globals";
import { NAVIGATION_GROUPS, filterNavigationGroups } from "./navigation.js";

const allow = (permissions) => (required) =>
  required.some((permission) => permissions.includes(permission));

test("admin navigation shows every group", () => {
  const permissions = [
    "workflow:read",
    "workflow:write",
    "workflow:run",
    "settings:manage",
    "user:manage",
    "audit:read",
  ];

  const visible = filterNavigationGroups(NAVIGATION_GROUPS, allow(permissions), "role_admin");
  expect(visible.map((group) => group.id)).toEqual(
    NAVIGATION_GROUPS.map((group) => group.id)
  );
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
