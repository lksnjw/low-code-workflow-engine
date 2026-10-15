import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const source = resolve("fixtures/parity/http/route-wire-capture.json");
const target = resolve("src/http/generated-routes.ts");
const capture = JSON.parse(await readFile(source, "utf8"));
const routes = capture.routes.map(({ method, pattern }) => ({ method, path: pattern }));
if (routes.length !== 168) throw new Error(`expected 168 explicit routes, found ${routes.length}`);
// Keep the captured graph immutable; name every intentional product extension.
routes.push(...[
  "/api/executions/:id/approve", "/api/executions/:id/reject", "/api/executions/:id/reconcile",
  "/api/workflows/:id/approve-generation", "/api/workflows/:id/reject-generation",
  "/api/workflows/:id/commands", "/api/workflows/:id/node-proposals",
  "/api/workflows/:id/readiness",
  "/api/executions/:id/events",
  "/api/execution-reviews",
  "/api/settings/runtime-approval-policy",
  "/api/chat/models",
  "/api/chat/capabilities",
  "/api/registry/capabilities", "/api/registry/capabilities/discovery", "/api/registry/capabilities/import", "/api/registry/capabilities/:id/review", "/api/registry/capabilities/:id/disable",
  "/api/settings/mcp-connections", "/api/settings/mcp-connections/:id/connect", "/api/settings/mcp-connections/:id/disconnect", "/api/settings/mcp-connections/:id/test",
  "/api/chat/sessions/:id/operations", "/api/chat/operations/:id", "/api/chat/operations/:id/cancel",
].map((path) => ({ method: /\/(readiness|events|models|operations|capabilities|mcp-connections)$/.test(path) || path === "/api/chat/operations/:id" || path === "/api/execution-reviews" || path === "/api/settings/runtime-approval-policy" ? "GET" : "POST", path })));
routes.push({ method: "GET", path: "/api/executions/:id/readbacks" }, { method: "POST", path: "/api/executions/:id/readbacks" },
  { method: "POST", path: "/api/executions/:id/readbacks/:queryId/cancel" });
routes.push({ method: "GET", path: "/api/executions/:id/recovery-artifacts" }, { method: "POST", path: "/api/executions/:id/recovery-artifacts" });
routes.push({ method: "POST", path: "/api/executions/:id/recovery-artifacts/:artifactId/admit" });
routes.push({ method: "GET", path: "/api/executions/:id/report-page-resolutions" }, { method: "POST", path: "/api/executions/:id/report-page-resolutions" });
routes.push({ method: "GET", path: "/api/workflows/:id/schedule" }, { method: "PUT", path: "/api/workflows/:id/schedule" });
routes.push({ method: "GET", path: "/api/workflows/:id/run-receipts/:key" });
routes.push({ method: "GET", path: "/api/dashboard/tasks" });
routes.push(
  { method: "GET", path: "/api/pipeline/v1/health/ready" },
  { method: "POST", path: "/api/pipeline/v1/files/csv" },
  { method: "POST", path: "/api/pipeline/v1/files/documents" },
  { method: "GET", path: "/api/pipeline/v1/jobs/:id" },
);
routes.push(
  { method: "GET", path: "/api/pipeline/v1/library/catalog" }, { method: "POST", path: "/api/pipeline/v1/library/catalog" },
  { method: "GET", path: "/api/pipeline/v1/library/inventory" },
  { method: "POST", path: "/api/pipeline/v1/library/search" }, { method: "POST", path: "/api/pipeline/v1/library/resolve" },
  { method: "POST", path: "/api/pipeline/v1/library/migrate" },
  { method: "POST", path: "/api/pipeline/v1/library/delegation" },
  { method: "GET", path: "/api/chat/sessions/:id/attachments" }, { method: "POST", path: "/api/chat/sessions/:id/attachments" },
  { method: "POST", path: "/api/chat/sessions/:id/attachments/preview" },
  { method: "POST", path: "/api/chat/sessions/:id/attachments/prepare" },
  { method: "GET", path: "/api/chat/sessions/:id/attachments/:uploadId" },
  ...["analyse", "confirm", "recover"].map(action => ({ method: "POST", path: `/api/chat/sessions/:id/attachments/:uploadId/${action}` })),
);
routes.push({ method: "GET", path: "/api/profile/erp-connections" },
  { method: "PUT", path: "/api/profile/erp-connections/:id" },
  { method: "DELETE", path: "/api/profile/erp-connections/:id" },
  { method: "POST", path: "/api/profile/erp-connections/:id/test" });
routes.push({ method: "GET", path: "/api/chat/sessions/:id/erp-actions/:actionId" }, { method: "POST", path: "/api/chat/sessions/:id/erp-actions/:actionId" });
routes.push({ method: "GET", path: "/api/settings/rag-policy" }, { method: "POST", path: "/api/settings/rag-policy/test" }, { method: "POST", path: "/api/settings/rag-policy/documents" });
const content = `// Generated from frozen Go routes plus named product extensions. Do not hand-edit.\n` +
  `export const routeTable = ${JSON.stringify(routes, null, 2)} as const;\n` +
  `export type RouteDefinition = (typeof routeTable)[number];\n`;
await mkdir(dirname(target), { recursive: true });
await writeFile(target, content);
console.log(`generated ${routes.length} routes`);
