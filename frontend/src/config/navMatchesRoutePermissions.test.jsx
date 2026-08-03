/** @jest-environment jsdom */

import { expect, test } from "@jest/globals";
import { NAVIGATION_GROUPS, filterNavigationGroups } from "../constants/navigation";
import { protectedRouteDefinitions } from "./router.jsx";

// The four real roles, with the permission sets the backend actually derives.
const ROLES = {
  "Platform Admin": [
    "workflow:read", "workflow:write", "workflow:run", "workflow_view_all", "chat:use",
    "workflow:read_own", "workflow:run_own", "execution:read_own", "settings:manage",
    "provider:manage", "registry:read", "registry:write", "user:manage", "audit:read",
  ],
  "System Admin": ["user:manage", "registry:read", "audit:read"],
  "Workflow Builder": ["workflow:read", "workflow:write", "workflow:run", "workflow_view_all", "chat:use", "registry:read"],
  Client: ["chat:use", "workflow:read_own", "workflow:run_own", "execution:read_own"],
};

const ROLE_IDS = {
  "Platform Admin": "role_admin",
  "System Admin": "role_system_admin",
  "Workflow Builder": "role_builder",
  Client: "role_client",
};

const routeByPath = new Map(protectedRouteDefinitions.map((route) => [route.path, route]));
const hasAnyFor = (permissions) => (required) =>
  !required?.length || required.some((permission) => permissions.includes(permission));

// Every navigable destination, from every navigation surface a user can click.
function visibleNavEntries(permissions, roleId) {
  const groups = filterNavigationGroups(NAVIGATION_GROUPS, hasAnyFor(permissions), roleId);
  const entries = [];
  groups.forEach((group) => {
    group.subMenu.forEach((item) => entries.push({ surface: "sidebar", group: group.id, path: item.path, label: item.label }));
  });
  // The command palette's quick targets navigate to each group's first item.
  groups.slice(0, 4).forEach((group) => {
    const first = group.subMenu[0];
    if (first) entries.push({ surface: "commandPalette", group: group.id, path: first.path, label: group.label });
  });
  return entries;
}

test("every visible nav entry resolves to a route the role is permitted to open", () => {
  const offenders = [];

  for (const [role, permissions] of Object.entries(ROLES)) {
    const hasAny = hasAnyFor(permissions);
    for (const entry of visibleNavEntries(permissions, ROLE_IDS[role])) {
      const route = routeByPath.get(entry.path);
      if (!route) {
        offenders.push(`${role}: ${entry.surface} "${entry.label}" -> ${entry.path} has NO route`);
        continue;
      }
      if (route.requiredAny?.length && !hasAny(route.requiredAny)) {
        offenders.push(
          `${role}: ${entry.surface} "${entry.label}" -> ${entry.path} requires [${route.requiredAny.join(", ")}] but the role has [${permissions.join(", ")}]`,
        );
      }
    }
  }

  expect(offenders).toEqual([]);
});

test("the command palette hides quick targets a role cannot open", () => {
  // System Admin lacks workflow:read, so Dashboard/Workflows/Agent Chat must not
  // be offered as shortcuts. This is the exact regression that was shipped.
  const systemAdmin = visibleNavEntries(ROLES["System Admin"], ROLE_IDS["System Admin"]).filter(
    (entry) => entry.surface === "commandPalette",
  );
  const labels = systemAdmin.map((entry) => entry.label);
  expect(labels).not.toContain("Dashboard");
  expect(labels).not.toContain("Workflows");
  expect(labels).not.toContain("Agent Chat");

  const client = visibleNavEntries(ROLES.Client, ROLE_IDS.Client)
    .filter((entry) => entry.surface === "commandPalette")
    .map((entry) => entry.label);
  expect(client).not.toContain("Dashboard");
});

test("a role with no permissions is offered no navigation at all", () => {
  expect(visibleNavEntries([], "role_none").filter((entry) => entry.surface === "sidebar").map((e) => e.path))
    .toEqual(["/company", "/profile", "/profile/security"]);
});
