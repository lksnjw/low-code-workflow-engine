import { expect, test } from "@jest/globals";
import { resolveRouteComponent } from "./permission.utils.js";

test("a forbidden direct route resolves to the access-denied page", () => {
  function SettingsPage() {}
  function AccessDeniedPage() {}
  const clientPermissions = ["chat:use", "workflow:read_own"];
  const hasAny = (required) => required.some((permission) => clientPermissions.includes(permission));

  const resolved = resolveRouteComponent(
    { Component: SettingsPage, requiredAny: ["settings:manage"] },
    hasAny,
    AccessDeniedPage
  );

  expect(resolved).toBe(AccessDeniedPage);
});
