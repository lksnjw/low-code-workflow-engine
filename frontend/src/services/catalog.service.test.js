import { afterEach, expect, jest, test } from "@jest/globals";
import { apiClient } from "../config/axios";
import { catalogService } from "./catalog.service";

afterEach(() => jest.restoreAllMocks());

test("builder includes live admitted discovered tools with no legacy status and preserves their required schema", async () => {
  const schema = { type: "object", properties: { customer_name: { type: "string" }, customer_type: { type: "string", enum: ["Company", "Individual"] } }, required: ["customer_name"], additionalProperties: false };
  const get = jest.spyOn(apiClient, "get").mockResolvedValue({ data: { success: true, data: [{ name: "discovered.create_customer", display_name: "Create customer", status: "", input_schema: schema, allowed_roles: ["Platform Admin"] }] } });
  const groups = await catalogService.toolGroups();
  expect(get).toHaveBeenCalledWith("/tools/catalog", { params: {} });
  expect(groups[0].tools[0]).toMatchObject({ action: "discovered.create_customer", inputSchema: schema, parameters: { customer_name: "{{input.customer_name}}" } });
});
