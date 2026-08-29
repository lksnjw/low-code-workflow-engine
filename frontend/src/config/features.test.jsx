/** @jest-environment jsdom */

import { expect, test } from "@jest/globals";
import { matchRoutes } from "react-router-dom";
import { NAVIGATION_GROUPS } from "../constants/navigation";
import { features } from "./features";
import { appRouteObjects, protectedRouteDefinitions } from "./router.jsx";

const disabledPaths = [
  "/datafeed",
  "/datafeed/metrics",
  "/datafeed/configuration",
  "/registry-search",
  "/registry/import",
  "/registry/context",
  "/mcp-bridge",
];

test("feature flags are explicit booleans with incomplete groups disabled", () => {
  expect(Object.values(features).every((value) => typeof value === "boolean")).toBe(true);
  expect(features).toMatchObject({
    datafeed: false,
    registrySearch: false,
    registryImport: false,
    registryContext: false,
    mcpBridge: false,
    semanticSearch: false,
  });
});

test("disabled feature routes are unregistered and fall through to not found", () => {
  const registeredPaths = new Set(protectedRouteDefinitions.map((route) => route.path));

  for (const path of disabledPaths) {
    expect(registeredPaths.has(path)).toBe(false);
    const matches = matchRoutes(appRouteObjects, path);
    expect(matches?.at(-1)?.route.path).toBe("*");
  }
});

test("disabled feature paths are absent from shared navigation", () => {
  const navigationPaths = new Set(
    NAVIGATION_GROUPS.flatMap((group) => group.subMenu.map((item) => item.path))
  );

  for (const path of disabledPaths) expect(navigationPaths.has(path)).toBe(false);
});

test("registry read and edit routes remain registered", () => {
  const registeredPaths = new Set(protectedRouteDefinitions.map((route) => route.path));
  expect(registeredPaths.has("/registry/tools")).toBe(true);
  expect(registeredPaths.has("/registry/rules")).toBe(true);
});
