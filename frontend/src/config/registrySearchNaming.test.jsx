/** @jest-environment jsdom */

import { expect, test } from "@jest/globals";
import { NAVIGATION_GROUPS } from "../constants/navigation";
import { protectedRouteDefinitions } from "./router.jsx";

test("registry search route and navigation describe semantic retrieval", () => {
  const navigation = NAVIGATION_GROUPS.find((group) => group.id === "registry_search");
  const route = protectedRouteDefinitions.find((definition) => definition.id === "registry_search.overview");

  expect(navigation?.label).toBe("Registry Search");
  expect(navigation?.subMenu).toEqual([
    expect.objectContaining({ label: "Semantic Search", path: "/registry-search" }),
  ]);
  expect(route?.path).toBe("/registry-search");
  expect(protectedRouteDefinitions.some((definition) => definition.path === "/erp-models")).toBe(false);
});
