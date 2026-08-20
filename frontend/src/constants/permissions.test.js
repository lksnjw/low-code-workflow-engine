import { describe, expect, test } from "@jest/globals";
import { PERMISSIONS } from "./permissions.js";

describe("permission constants", () => {
  test("match the backend permission vocabulary exactly", () => {
    const backendPermissions = [
      "workflow:read",
      "workflow:write",
      "workflow:run",
      "workflow_view_all",
      "chat:use",
      "workflow:read_own",
      "workflow:run_own",
      "execution:read_own",
      "settings:manage",
      "provider:manage",
      "registry:read",
      "registry:write",
      "user:manage",
      "audit:read",
    ];

    expect(Object.values(PERMISSIONS).sort()).toEqual(backendPermissions.sort());
  });
});
