/** @jest-environment jsdom */

import { expect, test } from "@jest/globals";
import { NAVIGATION_GROUPS } from "../constants/navigation";
import { protectedRouteDefinitions } from "./router.jsx";

test("disabled registry search is absent from routing and navigation", () => {
  const navigation = NAVIGATION_GROUPS.find((group) => group.id === "registry_search");
  const route = protectedRouteDefinitions.find((definition) => definition.id === "registry_search.overview");

  expect(navigation).toBeUndefined();
  expect(route).toBeUndefined();
  expect(protectedRouteDefinitions.some((definition) => definition.path === "/erp-models")).toBe(false);
});
