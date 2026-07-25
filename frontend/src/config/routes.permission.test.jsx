/** @jest-environment jsdom */

import { expect, jest, test } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import React from "react";

jest.unstable_mockModule("../hooks/usePermissions", () => ({
  default: () => ({ hasAny: () => false }),
}));

const { ProtectedScreen } = await import("./router.jsx");

test("routes.permission.test", async () => {
  const ForbiddenContent = () => <p>restricted content</p>;
  render(
    <ProtectedScreen
      definition={{
        id: "restricted.test",
        Component: ForbiddenContent,
        requiredAny: ["registry:write"],
      }}
    />
  );

  expect(await screen.findByText("Access denied")).not.toBeNull();
  expect(screen.queryByText("restricted content")).toBeNull();
});
