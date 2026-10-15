import type { ErpbridgeMcpSdkTool } from "../tools/erpbridge-mcp-client.js";

// Search vocabulary only. These aliases never select a tool, supply business
// arguments, grant access, or turn a read into an executable change.
const groups = [
  ["create", "add", "register", "registration", "onboard", "onboarding"],
  ["update", "edit", "amend", "change"],
  ["customer", "customers", "client", "clients"],
  ["item", "items", "product", "products"],
  ["stock", "inventory"],
  ["employee", "employees", "staff", "worker", "workers"],
  ["supplier", "suppliers", "vendor", "vendors"],
  ["invoice", "invoices", "bill", "bills"],
];
const words = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const stopWords = new Set(["a", "an", "the", "this", "that", "these", "those", "please", "i", "want", "to", "my", "our", "for"]);

export function matchingErpCatalog(catalog: readonly ErpbridgeMcpSdkTool[], search: string): ErpbridgeMcpSdkTool[] {
  if (!search.trim()) return [...catalog];
  const terms = words(search).filter(word => !stopWords.has(word)).slice(0, 8);
  if (!terms.length) return [];
  return catalog.filter(tool => {
    // Exact technical selectors remain supported for advanced users.
    if (tool.name === search.trim()) return true;
    const haystack = new Set(words(`${tool.name} ${tool.description ?? ""}`));
    return terms.every(term => (groups.find(group => group.includes(term)) ?? [term]).some(alias => haystack.has(alias)));
  });
}

/** Conservative presentation only; exact names/arguments remain in receipts. */
export function erpBusinessActionLabel(name: string, args: Record<string, unknown> = {}): string {
  const tokens = words(name.split(/[.:/]/).at(-1) ?? "");
  if (tokens.includes("send") && tokens.some(token => ["email", "emails", "mail"].includes(token))) return "Send email";
  const verbs: Record<string, string> = { create: "Create", update: "Update", delete: "Delete", remove: "Remove", submit: "Submit", cancel: "Cancel", complete: "Complete", reopen: "Reopen", send: "Send", assign: "Assign" };
  const verb = Object.hasOwn(verbs, tokens[0] ?? "") ? verbs[tokens[0]!] : undefined;
  if (!verb || tokens.length < 2) return "ERP change";
  const target = tokens.slice(1).join(" ");
  const record = target === "document" && typeof args.doctype === "string" && /^[A-Za-z][A-Za-z -]{0,63}$/.test(args.doctype)
    ? args.doctype.toLowerCase() : target;
  return `${verb} ${record}`;
}
