/** @jest-environment jsdom */

import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import RoleCreateForm from "./RoleCreateForm.jsx";

afterEach(cleanup);

test("TestRoleCreateFromUIRestrictedToCallerPermissions", async () => {
  const onCreate = jest.fn().mockResolvedValue(undefined);
  render(
    <RoleCreateForm
      permissions={[
        { key: "user:manage", name: "Manage users", description: "Manage users." },
        { key: "registry:read", name: "Read registries", description: "Read registries." },
        { key: "provider:manage", name: "Manage providers", description: "Manage provider secrets." },
        { key: "registry:write", name: "Write registries", description: "Write registries." },
      ]}
      callerPermissions={["user:manage", "registry:read"]}
      canManage
      onCreate={onCreate}
    />
  );

  expect(screen.getByRole("checkbox", { name: "Manage users" })).not.toBeNull();
  expect(screen.getByRole("checkbox", { name: "Read registries" })).not.toBeNull();
  expect(screen.queryByRole("checkbox", { name: "Manage providers" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "Write registries" })).toBeNull();

  fireEvent.change(screen.getByLabelText("Role name"), { target: { value: "System Auditor" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Read registries" }));
  fireEvent.click(screen.getByRole("button", { name: "Create role" }));

  await waitFor(() => {
    expect(onCreate).toHaveBeenCalledWith({
      name: "System Auditor",
      description: "",
      permissions: ["registry:read"],
    });
  });
});
