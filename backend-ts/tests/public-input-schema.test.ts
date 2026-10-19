import { expect, test } from "vitest";
import { publicInputSchema } from "../src/tools/public-input-schema.js";

test("builder schema preserves real argument types while omitting source defaults and secret choices", () => {
  const source = { type: "object", properties: { customer_name: { type: "string", default: "Sample customer", examples: ["Private sample"] },
    customer_type: { type: "string", enum: ["Company", "Individual"] }, quantity: { type: "integer" }, api_key: { type: "string", enum: ["private credential"] },
    rows: { type: "array", maxItems: 50, items: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false } } },
    required: ["customer_name", "customer_type"], additionalProperties: false };
  const projected = publicInputSchema(source) as any;
  expect(projected.properties.customer_type.enum).toEqual(["Company", "Individual"]);
  expect(projected.properties.quantity.type).toBe("integer"); expect(projected.properties.rows.maxItems).toBe(50);
  expect(projected.properties.api_key).toEqual({ type: "string", writeOnly: true });
  expect(JSON.stringify(projected)).not.toMatch(/Sample customer|Private sample|private credential/);
  expect(source.properties.api_key.enum).toEqual(["private credential"]);
});
