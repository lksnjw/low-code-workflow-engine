import { expect, test } from "vitest";
import { workflowSummary } from "../src/workflows/summary.js";
import { executionListPage, filterExecutions } from "../src/http/execution-filters.js";
import type { Workflow } from "../src/models/schemas.js";
import type { Execution } from "../src/repository/store.js";
const workflow = { id: "wf", status: "PENDING", publishedVersion: 1, draftVersion: 1, canRun: true, yaml: "private", archived: false, canvas: { private: true }, lastRunAt: null, successRate: 0 } as unknown as Workflow;
const run = (id: string, status: string, startedAt = "2026-10-14T06:00:00Z") => ({ id, workflowId: "wf", workflowName: "Invoice review", status, startedAt }) as Execution;
test("workflow cards derive publication and run statistics without mutating evidence", () => {
  const source = structuredClone(workflow), result = workflowSummary(workflow, [run("first", "FAILED"), run("last", "DONE", "2026-10-14T07:00:00Z")]);
  expect(result).toMatchObject({ status: "PUBLISHED", lastRunAt: "2026-10-14T07:00:00Z", successRate: 50 });
  expect(result).not.toHaveProperty("yaml"); expect(result).not.toHaveProperty("canvas"); expect(workflow).toEqual(source);
  expect(workflowSummary({ ...workflow, draftVersion: 2 }, []).status).toBe("PENDING");
});
test("execution filters combine status, search and time range", () => {
  const runs = [run("done", "DONE"), run("failed", "FAILED"), run("old", "DONE", "2026-09-01T06:00:00Z")];
  expect(filterExecutions(runs, { q: "invoice", status: "DONE", range: "24h" }, Date.parse("2026-10-14T08:00:00Z")).map(value => value.id)).toEqual(["done"]);
  expect(filterExecutions(runs, { q: "FAILED" }).map(value => value.id)).toEqual(["failed"]);
  expect(() => filterExecutions(runs, { status: "made-up" })).toThrow("Invalid execution");
  expect(() => filterExecutions(runs, { range: ["24h"] })).toThrow("Invalid execution");
});
test("publication status is distinct from the current viewer's run permission", () => {
  const owned = { ...workflow, owner: { id: "owner", name: "Owner" }, assignedUserIds: ["assigned"] };
  expect(workflowSummary(owned, [], { id: "reviewer", permissions: ["workflow:read", "execution:approve"] })).toMatchObject({ status: "PUBLISHED", canRun: false });
  expect(workflowSummary(owned, [], { id: "unassigned", permissions: ["workflow:run_own"] }).canRun).toBe(false);
  expect(workflowSummary(owned, [], { id: "assigned", permissions: ["workflow:run_own"] }).canRun).toBe(true);
});

test("latest-result limits preserve matching totals, stable newest-first order and legacy complete lists", () => {
  const runs = [run("older", "DONE", "2026-10-13T06:00:00Z"), run("new-b", "DONE"), run("new-a", "DONE"), { ...run("foreign", "DONE"), workflowId: "other" }];
  const page = executionListPage(runs, { workflowId: "wf", limit: "1" });
  expect(page.items.map(value => value.id)).toEqual(["new-a"]);
  expect(page.meta).toEqual({ page: 1, limit: 1, total: 3, totalPages: 3 });
  expect(filterExecutions(runs, { workflowId: "wf" })).toHaveLength(3);
  expect(executionListPage([], { limit: 1 })).toEqual({ items: [], meta: { page: 1, limit: 1, total: 0, totalPages: 0 } });
});

test.each([0, -1, 201, 1.5, "1.5", "1e2", "", "Infinity", ["1"], { value: 1 }, true, null])("invalid execution page limit %j is rejected rather than broadened", limit => {
  expect(() => executionListPage([run("saved", "DONE")], { limit })).toThrow("Invalid execution");
});
