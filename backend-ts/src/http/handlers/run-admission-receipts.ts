import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ok } from "../../models/schemas.js";
import { readJobQueue } from "../../runner/read-jobs.js";
import { operationJobQueue } from "../../runner/operation-jobs.js";
import { canReviewStoppedRunForNewRun } from "../../runner/execution-retry.js";
import { HandlerFailure, requestParam, type CurrentUser, type HandlerServices } from "./common.js";

/** An absent receipt is not proof of non-entry: the original request may still
 * be in flight. This handler cannot admit, resume, retry or dispatch anything. */
export async function getRunAdmissionReceipt(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const workflowId = requestParam(request, "id"), key = requestParam(request, "key");
  const parsed = z.object({ mode: z.enum(["async-read", "async-operation"]) }).strict().safeParse(request.query);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key) || !parsed.success) throw new HandlerFailure(400, "An exact queued admission identity is required");
  const queue = parsed.data.mode === "async-read" ? readJobQueue(services) : operationJobQueue(services);
  let receipt;
  try {
    receipt = await services.repository.readAuthoritative(state => {
      const actor = state.users[user.id], role = actor && state.roles[actor.roleId];
      const permissions = [...(role?.permissions ?? []), ...(actor?.permissionOverrides ?? [])];
      if (!actor || actor.status.toLowerCase() !== "active" || !permissions.some(value => ["workflow:read", "execution:read_own"].includes(value)))
        throw new HandlerFailure(404, "Run receipt unavailable");
      const run = queue.findAdmission(state, workflowId, user.id, key);
      return { profile: "run-admission-receipt/v1", outcome: run ? "RECORDED" : "NOT_FOUND", workflowId, mode: parsed.data.mode,
        executionId: run?.id ?? null, status: run?.status ?? null, noReplay: true,
        safeToReviewForNewRun: !!run && canReviewStoppedRunForNewRun(state, user, run) };
    });
  } catch (error) {
    try { services.repository.assertAuthority(); } catch { throw new HandlerFailure(503, "Authoritative run receipts are unavailable. Do not repeat the original request."); }
    if (error instanceof HandlerFailure) throw error;
    throw new HandlerFailure(503, "Authoritative run receipts could not be loaded. Do not repeat the original request.");
  }
  return reply.header("Cache-Control", "no-store").send(ok(receipt, "Identity evidence only; absence is not proof that a request did not enter", null));
}
