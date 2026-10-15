import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RouteDefinition } from "../generated-routes.js";
import { HandlerFailure, type CurrentUser, type HandlerServices } from "./common.js";
import { assertActorAuthority } from "./model-selection.js";
import { boundedJSONRequest } from "../../core/bounded-json-request.js";
import { directRagConfigured, DIRECT_RAG_HANDOFF_MS } from "../../governance/direct-rag.js";
import { policySwitches } from "../../governance/optional-policy.js";
import { ok } from "../../models/schemas.js";
import { recordPolicySchema, recordPolicyContentHash } from "../../governance/record-policy-contract.js";
import { appendAudit } from "./common.js";

export const RAG_POLICY_UNHANDLED = Symbol("rag-policy-unhandled");
const testInput = z.object({ prompt: z.string().trim().min(1).max(2000), action: z.enum(["create_customer", "create_item", "delete_record"]).optional(), arguments: z.record(z.string(), z.unknown()).optional() }).strict().refine(value => Boolean(value.action) === Boolean(value.arguments));
const actionSchema = z.object({ name: z.string().max(128), description: z.string().max(4000), risk: z.string().max(32), parameters: z.record(z.string(), z.unknown()) });

/** Backend-only policy console. Publication uses a separate admin credential;
 * no request here executes any proposed ERP action. */
export async function handleRagPolicyRoute(route: RouteDefinition, request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices) {
  const base = `${services.config.apiBasePath}/settings/rag-policy`;
  if (![base, `${base}/test`, `${base}/documents`].includes(route.path)) return RAG_POLICY_UNHANDLED;
  const assertCurrent = () => services.repository.readAuthoritative(state => {
    assertActorAuthority(state, user);
    if (!user.permissions.includes("settings:manage")) throw new HandlerFailure(403, "Settings management permission is required");
  });
  await assertCurrent();
  const canPublish = () => services.repository.readAuthoritative(state => {
    assertActorAuthority(state, user);
    if (state.users[user.id]?.roleId !== "role_admin" || !user.permissions.includes("registry:write") || !user.permissions.includes("settings:manage"))
      throw new HandlerFailure(403, "Only the built-in administrator can publish governing policies");
  });
  reply.header("Cache-Control", "no-store");
  const configured = directRagConfigured(services.config);
  if (!configured) {
    if (route.method === "POST") throw new HandlerFailure(503, "Configure the backend RAG connection before testing", { code: "RAG_UNAVAILABLE" });
    return reply.send(ok({ configured: false, state: "UNCONFIGURED", policyImportAvailable: false, actions: [] }, "RAG connection is not configured", null));
  }
  const call = async (path: string, body?: unknown, authoring = false) => {
    try {
      const result = await boundedJSONRequest(fetch, new URL(path, services.config.ragPolicyAPIBaseURL).href, {
        method: body === undefined ? "GET" : "POST", redirect: "error",
        ...(request.signal ? { signal: request.signal } : {}),
        headers: { "X-API-Key": services.config.ragPolicyAPIKey!, Accept: "application/json", ...(authoring ? { "X-Policy-Admin-Key": services.config.ragPolicyAdminAPIKey! } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, authoring && body !== undefined ? 30000 : DIRECT_RAG_HANDOFF_MS, "RAG policy console");
      if (!result.response.ok) throw new HandlerFailure([401, 403].includes(result.response.status) ? 502 : 503, "The backend RAG connection did not confirm this request", { code: "RAG_SERVICE_REJECTED" });
      if (JSON.stringify(result.decoded).length > 256000) throw new HandlerFailure(502, "RAG response exceeded its supported size");
      return result.decoded;
    } catch (error) {
      if (error instanceof HandlerFailure) throw error;
      throw new HandlerFailure(504, "RAG did not confirm a response in time. Check the current policy list before retrying publication. No ERP operation was performed.", { code: "RAG_RESPONSE_UNCONFIRMED" });
    }
  };
  if (route.method === "GET") {
    const [rawHealth, rawActions] = await Promise.all([call("/health"), call("/api/policy/actions")]);
    const health = z.object({ status: z.string(), policy_collection: z.string(), policy_chunks: z.number().int().nonnegative(), embed_model: z.string(), embed_dimension: z.number().int().positive(), fail_closed: z.boolean() }).safeParse(rawHealth);
    const actions = z.object({ registry_version: z.string(), actions: z.array(actionSchema).max(100), record_registry_version: z.string().optional(), record_actions: z.array(actionSchema).max(10).optional() }).safeParse(rawActions);
    if (!health.success || !actions.success) throw new HandlerFailure(502, "RAG status or action contract is not supported");
    await assertCurrent();
    const switches = await services.repository.read(state => policySwitches(state.settings.rbac));
    let policyImportAvailable = false, policies: z.infer<typeof recordPolicySchema>[] = [];
    let policyImportReason = "The deployed RAG release or its separate authoring credential does not support policy publication yet. Drafts are not active rules.";
    if (services.config.ragPolicyAdminAPIKey) try {
      await canPublish();
      const documents = z.object({ profile: z.literal("record-policy/v1"), items: z.array(recordPolicySchema).max(300), supports_publish: z.literal(true), supports_delete: z.literal(false) }).parse(await call("/api/policy/documents", undefined, true));
      policies = documents.items; policyImportAvailable = true;
      policyImportReason = "Reviewed record-field and delete-protection rules can be published. Existing finance policies remain separate. Replacement and deletion are not supported.";
    } catch { /* Connected evaluation is separate from unavailable administration. */ }
    await assertCurrent();
    return reply.send(ok({ configured: true, state: health.data.status === "ok" ? "CONNECTED" : "DEGRADED", health: health.data, ...actions.data, switches,
      policyImportAvailable, policyImportReason, policies,
      executionPerformed: false }, "RAG status and supported actions checked", null));
  }
  if (route.path === `${base}/documents`) {
    await canPublish();
    const input = z.object({ policy: recordPolicySchema, reviewConfirmed: z.literal(true) }).strict().safeParse(request.body);
    if (!input.success) throw new HandlerFailure(422, "Review the supported policy fields and explicitly confirm publication");
    if (!services.config.ragPolicyAdminAPIKey) throw new HandlerFailure(503, "The separate backend policy-administrator credential is not configured");
    const policy = input.data.policy, contentHash = recordPolicyContentHash(policy);
    await services.repository.mutate(state => { assertActorAuthority(state, user); appendAudit(state, user, "rag.policy.publish.requested", "record-policy", policy.policy_id, null, { version: policy.version, contentHash }, request); });
    await canPublish();
    const raw = await call("/api/policy/documents", policy, true);
    const receipt = z.object({ status: z.literal("INDEXED"), policy_id: z.literal(policy.policy_id), version: z.literal(policy.version), content_hash: z.literal(contentHash), duplicate: z.boolean() }).safeParse(raw);
    if (!receipt.success) throw new HandlerFailure(502, "Policy indexing was not confirmed for this exact content. Check the policy list before retrying.", { code: "RAG_RESPONSE_UNCONFIRMED" });
    await canPublish();
    await services.repository.mutate(state => { assertActorAuthority(state, user); appendAudit(state, user, "rag.policy.indexed", "record-policy", policy.policy_id, null, { version: policy.version, contentHash }, request); });
    return reply.send(ok({ ...receipt.data, executionPerformed: false }, "Policy indexed; no ERP action performed", null));
  }
  const parsed = testInput.safeParse(request.body);
  if (!parsed.success) throw new HandlerFailure(422, "Enter a policy question of up to 2000 characters; the actor comes from your signed-in account");
  const raw = await call(parsed.data.action ? "/api/policy/records/evaluate" : "/api/policy/evaluate", { prompt: parsed.data.prompt, actor: { user_id: user.id, role: user.role }, context: parsed.data.action ? { action: parsed.data.action, arguments: parsed.data.arguments } : {} });
  const result = z.object({ request_id: z.string().max(200), request_type: z.string().max(32), decision: z.string().max(64), reason: z.string().max(8000), knowledge: z.string().max(32000).optional(),
    conditions: z.array(z.unknown()).max(100), citations: z.array(z.unknown()).max(100), retrieval: z.object({ total_unique: z.number().int().nonnegative() }) }).safeParse(raw);
  if (!result.success) throw new HandlerFailure(502, "The RAG evaluation response is invalid");
  await assertCurrent();
  return reply.send(ok({ ...result.data, actor: { id: user.id, role: user.role }, executionPerformed: false,
    warning: "Evaluation only. A policy answer is not permission to execute an ERP operation." }, "Policy evaluated; no ERP operation performed", null));
}
