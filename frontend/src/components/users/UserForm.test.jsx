/** @jest-environment jsdom */

import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { apiClient } from "../../config/axios.js";

const notify = jest.fn();
jest.unstable_mockModule("../../context/NotificationContext", () => ({
  useNotifications: () => ({ notify }),
}));

const { default: UserForm } = await import("./UserForm.jsx");

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  notify.mockClear();
});

test("Create User button submits the account form", async () => {
  const post = jest.spyOn(apiClient, "post").mockResolvedValue({
    data: {
      success: true,
      data: { id: "usr_2", name: "Client User", role: { name: "Client" } },
    },
  });
  const onCreated = jest.fn();

  render(
    <UserForm
      roles={[
        { id: "role_builder", name: "Workflow Builder" },
        { id: "role_client", name: "Client" },
      ]}
      onCreated={onCreated}
    />
  );

  fireEvent.change(screen.getByPlaceholderText("Full name"), { target: { value: "Client User" } });
  fireEvent.change(screen.getByPlaceholderText("Email address"), { target: { value: "client@example.test" } });
  fireEvent.change(screen.getByPlaceholderText("Temporary password (8+ characters)"), { target: { value: "client-password" } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "role_client" } });
  fireEvent.click(screen.getByRole("button", { name: "Create User" }));

  await waitFor(() => {
    expect(post).toHaveBeenCalledWith("/users", {
      name: "Client User",
      email: "client@example.test",
      password: "client-password",
      roleId: "role_client",
    });
  });
  expect(onCreated).toHaveBeenCalledTimes(1);
});

test("System Admin can only assign Builder and Client roles", () => {
  render(
    <UserForm
      actorRoleId="role_system_admin"
      roles={[
        { id: "role_admin", name: "Platform Admin" },
        { id: "role_system_admin", name: "System Admin" },
        { id: "role_builder", name: "Workflow Builder" },
        { id: "role_client", name: "Client" },
      ]}
    />
  );

  const options = Array.from(screen.getByRole("combobox").options).map((option) => option.value);
  expect(options).toEqual(["role_builder", "role_client"]);
});
