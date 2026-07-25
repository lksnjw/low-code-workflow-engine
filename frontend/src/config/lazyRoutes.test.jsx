/** @jest-environment jsdom */

import { expect, test } from "@jest/globals";
import { lazyRouteComponents, protectedRouteDefinitions } from "./router.jsx";

test("lazyRoutes.test", () => {
  const lazyType = Symbol.for("react.lazy");
  expect(Object.values(lazyRouteComponents).every((Component) => Component.$$typeof === lazyType)).toBe(true);
  expect(protectedRouteDefinitions.every((route) => route.Component.$$typeof === lazyType)).toBe(true);
});
