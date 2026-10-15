import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { routeTable, type RouteDefinition } from "../src/http/generated-routes.js";
import { handlePipelineGatewayRoute } from "../src/http/handlers/pipeline-gateway.js";
import type { CurrentUser, HandlerServices } from "../src/http/handlers/common.js";
import { routePolicy } from "../src/http/route-policy.js";
import { initialState, Repository, restoreState } from "../src/repository/store.js";

const documentRoute = routeTable.find(route => route.method === "POST" && route.path === "/api/pipeline/v1/files/documents")!;

function currentUser(): CurrentUser {
  return {
    id: "user-1",
    name: "Ada Admin",
    email: "ada@example.test",
    roleId: "role_admin",
    permissionOverrides: [],
    permissions: ["pipeline:upload", "registry:write"],
    role: "Platform Admin",
    status: "active",
    initials: "AA",
    departmentId: null,
    lastLoginAt: null,
    createdAt: new Date(0).toISOString(),
  };
}

function uploadRequest(): FastifyRequest {
  return {
    headers: { "user-agent": "pipeline-gateway-test" },
    ip: "127.0.0.1",
    isMultipart: () => true,
    parts: async function* () {
      yield { type: "field", fieldname: "source_system_id", value: "hr_system" };
      yield { type: "field", fieldname: "source_entity", value: "employee" };
      yield { type: "field", fieldname: "business_key_name", value: "employee_id" };
      yield { type: "field", fieldname: "business_key_value", value: "EMP-10042" };
      yield {
        type: "file",
        fieldname: "file",
        filename: "birth-certificate.pdf",
        mimetype: "application/pdf",
        toBuffer: async () => Buffer.from("document-bytes"),
      };
    },
  } as unknown as FastifyRequest;
}

function replyRecorder() {
  const record = { status: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  const reply = {
    status(code: number) { record.status = code; return this; },
    send(body: unknown) { record.body = body; return body; },
    header(name: string, value: string) { record.headers[name] = value; return this; },
  } as unknown as FastifyReply;
  return { reply, record };
}

afterEach(() => vi.unstubAllGlobals());

describe("pipeline gateway", () => {
  test("non-administrators cannot bypass private review through legacy document ingestion", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const user = currentUser(); user.permissions = ["pipeline:upload"];
    await expect(handlePipelineGatewayRoute(documentRoute, uploadRequest(), replyRecorder().reply, user,
      { config: loadConfig({ APP_ENV: "test", PIPELINE_API_BASE_URL: "http://pipeline.test", PIPELINE_API_KEY: "pipeline-service-secret" }), repository: new Repository() } as HandlerServices,
    )).rejects.toMatchObject({ status: 403, meta: { code: "LEGACY_INGESTION_ADMIN_REQUIRED" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("protects every upload and status route with the dedicated permission", () => {
    for (const route of routeTable.filter(item => item.path.startsWith("/api/pipeline/") && !item.path.endsWith("/delegation")))
      expect(routePolicy(route)).toEqual({ required: ["pipeline:upload"], any: false });
  });

  test("keeps the API key server-side, forwards identity metadata, and audits the upload", async () => {
    const repository = new Repository();
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = init?.body as FormData;
      expect(init?.headers).toEqual({ Accept: "application/json", "X-API-Key": "pipeline-service-secret" });
      expect(body.get("source_system_id")).toBe("hr_system");
      expect(body.get("business_key_value")).toBe("EMP-10042");
      expect(body.get("file")).toBeInstanceOf(Blob);
      return new Response(JSON.stringify({ upload_id: "upload-1", index_job_id: "job-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { reply, record } = replyRecorder();
    const config = loadConfig({
      APP_ENV: "test",
      PIPELINE_API_BASE_URL: "http://pipeline.test",
      PIPELINE_API_KEY: "pipeline-service-secret",
    });

    await handlePipelineGatewayRoute(
      documentRoute,
      uploadRequest(),
      reply,
      currentUser(),
      { config, repository } as HandlerServices,
    );

    expect(fetchMock).toHaveBeenCalledWith(new URL("http://pipeline.test/v1/files/documents"), expect.objectContaining({ method: "POST" }));
    expect(record).toMatchObject({ status: 201, body: { upload_id: "upload-1", index_job_id: "job-1" } });
    const audit = (await repository.snapshot()).auditLogs;
    expect(audit.map(entry => entry.action)).toEqual(["pipeline.upload.requested", "pipeline.upload.completed"]);
    expect(JSON.stringify(audit)).not.toContain("EMP-10042");
    expect(JSON.stringify(audit)).not.toContain("birth-certificate.pdf");
  });

  test("returns a controlled failure when the server-side pipeline binding is absent", async () => {
    const { reply } = replyRecorder();
    await expect(handlePipelineGatewayRoute(
      documentRoute,
      uploadRequest(),
      reply,
      currentUser(),
      { config: loadConfig({ APP_ENV: "test" }), repository: new Repository() } as HandlerServices,
    )).rejects.toMatchObject({ status: 503, meta: { code: "PIPELINE_UNAVAILABLE" } });
  });
});

describe("pipeline permission migration", () => {
  test("an explicitly revoked pipeline permission remains revoked after repeated reloads", () => {
    const current = initialState();
    current.roles.role_admin!.permissions = [];
    const restored = restoreState(Buffer.from(JSON.stringify(current)));
    expect(restored.roles.role_admin!.permissions).toEqual([]);
    expect(restoreState(Buffer.from(JSON.stringify(restored))).roles.role_admin!.permissions).toEqual([]);
  });

  test("adds the permission and grants it to an existing platform administrator", () => {
    const legacy = initialState();
    legacy.permissions = legacy.permissions.filter(item => item.key !== "pipeline:upload");
    legacy.roles.role_admin!.permissions = legacy.roles.role_admin!.permissions.filter(item => item !== "pipeline:upload");

    const restored = restoreState(Buffer.from(JSON.stringify(legacy)));

    expect(restored.permissions).toContainEqual(expect.objectContaining({ key: "pipeline:upload", group: "Data Pipeline" }));
    expect(restored.roles.role_admin!.permissions).toContain("pipeline:upload");
  });
});

