import { expect, test } from "vitest";
import jwt from "jsonwebtoken";
import { boundedReadFixture } from "./fixtures/bounded-read-task.js";

test("HTTP retry admits one separate queued read, preserves the failed source, and rejects input substitution", async () => {
  const f = await boundedReadFixture();
  try {
    expect((await f.publish()).statusCode).toBe(200);
    const first = await f.run(); expect(first.statusCode, first.body).toBe(202); const sourceId = first.json().data.id;
    await f.repository.mutateExecution(sourceId, state => {
      state.executions[sourceId]!.status = "FAILED"; state.executions[sourceId]!.completedAt = new Date().toISOString();
      state.readJobs[sourceId]!.state = "FINISHED";
    });
    const before = structuredClone((await f.repository.snapshot()).executions[sourceId]);
    const body = { mode: "async-read", idempotencyKey: "explicit-retry-request-0001", retry: { sourceExecutionId: sourceId, acknowledgeUnconfirmed: false } };
    const get = await f.app.inject({ url: `/api/executions/${sourceId}`, headers: f.headers }); expect(get.json().data.retryAdmission.allowed).toBe(true);
    const retry = () => f.app.inject({ method: "POST", url: `/api/executions/${sourceId}/retry`, headers: f.headers, payload: body });
    const admitted = await retry(); expect(admitted.statusCode, admitted.body).toBe(202); const childId = admitted.json().data.id;
    expect(childId).not.toBe(sourceId); expect(admitted.json().data.retrySource.sourceExecutionId).toBe(sourceId);
    expect((await retry()).json().data.id).toBe(childId);
    expect((await f.repository.snapshot()).executions[sourceId]).toEqual(before); expect(f.sdk.callTool).not.toHaveBeenCalled();
    const changed = await f.app.inject({ method: "POST", url: `/api/executions/${sourceId}/retry`, headers: f.headers, payload: { ...body, input: { changed: true } } }); expect(changed.statusCode).toBe(400);
    const missingAuth = await f.app.inject({ method: "POST", url: `/api/executions/${sourceId}/retry`, payload: body }); expect(missingAuth.statusCode).toBe(401);
    await f.repository.mutate(state => { state.roles.observer = { id: "observer", name: "Observer", permissions: ["workflow:read"], description: "Read only", createdAt: new Date().toISOString() }; state.users.observer = { ...state.users.owner!, id: "observer", roleId: "observer" }; });
    const token = jwt.sign({}, f.services.config.jwtSecret, { subject: "observer", expiresIn: 3600 });
    const observer = await f.app.inject({ method: "POST", url: `/api/executions/${sourceId}/retry`, headers: { authorization: `Bearer ${token}` }, payload: body }); expect(observer.statusCode).toBe(403);
  } finally { await f.close(); }
});

test("HTTP list filters and workflow statistics reflect authoritative runs, not static counters", async () => {
  const f = await boundedReadFixture();
  try {
    expect((await f.publish()).statusCode).toBe(200); const first = (await f.run()).json().data.id;
    await f.repository.mutateExecution(first, state => { state.executions[first]!.status = "DONE"; state.readJobs[first]!.state = "FINISHED"; });
    const second = (await f.run("second-filter-test-key-0001")).json().data.id;
    await f.repository.mutateExecution(second, state => { state.executions[second]!.status = "FAILED"; state.readJobs[second]!.state = "FINISHED"; });
    const done = await f.app.inject({ url: "/api/executions?status=DONE&workflowId=workflow&range=24h", headers: f.headers });
    expect(done.statusCode, done.body).toBe(200); expect(done.json().data.map((run: { id: string }) => run.id)).toEqual([first]);
    const card = await f.app.inject({ url: "/api/workflows/workflow", headers: f.headers });
    expect(card.json().data).toMatchObject({ status: "PUBLISHED", successRate: 50 }); expect(card.json().data.lastRunAt).toBeTruthy();
    const pending = await f.app.inject({ url: "/api/workflows?status=PENDING", headers: f.headers }); expect(pending.json().data).toEqual([]);
  } finally { await f.close(); }
});

test("HTTP latest-result read bounds output after ownership filtering and rejects invalid limits", async () => {
  const f = await boundedReadFixture();
  try {
    expect((await f.publish()).statusCode).toBe(200);
    const first = (await f.run()).json().data.id;
    await f.repository.mutateExecution(first, state => { state.executions[first]!.status = "DONE"; state.executions[first]!.startedAt = "2026-10-17T08:00:00Z"; state.readJobs[first]!.state = "FINISHED"; });
    const second = (await f.run("latest-result-second-0001")).json().data.id;
    await f.repository.mutateExecution(second, state => { state.executions[second]!.status = "DONE"; state.executions[second]!.startedAt = "2026-10-18T08:00:00Z"; state.readJobs[second]!.state = "FINISHED"; });
    await f.repository.mutate(state => {
      state.roles.own_reader = { id: "own_reader", name: "Own reader", permissions: ["execution:read_own"], description: "Own results only", createdAt: new Date().toISOString() };
      state.users.own_reader = { ...state.users.owner!, id: "own_reader", roleId: "own_reader" };
    });
    const latest = await f.app.inject({ url: "/api/executions?workflowId=workflow&limit=1", headers: f.headers });
    expect(latest.statusCode, latest.body).toBe(200);expect(latest.json().data.map((value: { id: string }) => value.id)).toEqual([second]);
    expect(latest.json().meta).toMatchObject({ limit: 1, total: 2, totalPages: 2 });
    const token = jwt.sign({}, f.services.config.jwtSecret, { subject: "own_reader", expiresIn: 3600 });
    const hidden = await f.app.inject({ url: "/api/executions?workflowId=workflow&limit=1", headers: { authorization: `Bearer ${token}` } });
    expect(hidden.statusCode, hidden.body).toBe(200);expect(hidden.json().data).toEqual([]);expect(hidden.json().meta.total).toBe(0);
    for (const query of ["limit=0", "limit=201", "limit=1.5", "limit=1&limit=2", "limit=1&unreviewed=yes"]) {
      expect((await f.app.inject({ url: "/api/executions?" + query, headers: f.headers })).statusCode).toBe(400);
    }
    expect(f.sdk.callTool).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
