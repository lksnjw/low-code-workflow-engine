/** @jest-environment jsdom */

import { expect, test } from "@jest/globals";
import { NAVIGATION_GROUPS } from "../constants/navigation";
import { protectedRouteDefinitions } from "./router.jsx";

test("routes.allNavEntriesRouted", () => {
  const byID = new Map(protectedRouteDefinitions.map((route) => [route.id, route]));
  const navigationEntries = NAVIGATION_GROUPS.flatMap((group) =>
    group.subMenu.map((item) => ({ id: `${group.id}.${item.id}`, path: item.path }))
  );

  expect(new Set(navigationEntries.map((entry) => entry.path)).size).toBe(navigationEntries.length);
  for (const entry of navigationEntries) {
    expect(entry.path).toBeTruthy();
    expect(byID.get(entry.id)?.path).toBe(entry.path);
  }
});
