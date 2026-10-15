import { z } from "zod";
import { createHash } from "node:crypto";

export const recordPolicyFields = {
  create_customer: ["customer_name", "customer_group", "territory", "customer_type"],
  create_item: ["item_code", "item_name", "item_group", "stock_uom", "is_stock_item"],
  delete_record: ["doctype", "name"],
} as const;
export const recordPolicySchema = z.object({
  policy_id: z.string().regex(/^[A-Z][A-Z0-9-]{2,79}$/), version: z.string().regex(/^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/).max(32),
  title: z.string().min(3).max(200).refine(value => Boolean(value.trim())),
  action: z.enum(["create_customer", "create_item", "delete_record"]), kind: z.enum(["required_fields", "deny_delete", "administrator_exception"]),
  required_fields: z.array(z.string()).max(32).default([]), text: z.string().min(20).max(6000).refine(value => Boolean(value.trim())),
}).strict().superRefine((policy, ctx) => {
  const invalid = ["deny_delete", "administrator_exception"].includes(policy.kind) ? policy.action !== "delete_record" || policy.required_fields.length !== 0
    : policy.action === "delete_record" || !policy.required_fields.length || new Set(policy.required_fields).size !== policy.required_fields.length ||
      policy.required_fields.some(field => !(recordPolicyFields[policy.action] as readonly string[]).includes(field));
  if (invalid) ctx.addIssue({ code: "custom", message: "Select supported required fields or a delete-protection rule" });
});

/** Python record-policy/v1 uses sorted UTF-8 JSON, not ERPBridge's Go escaping. */
export function recordPolicyContentHash(policy: z.infer<typeof recordPolicySchema>): string {
  const sorted = Object.fromEntries(Object.keys(policy).sort().map(key => [key, policy[key as keyof typeof policy]]));
  return createHash("sha256").update(JSON.stringify(sorted), "utf8").digest("hex");
}
