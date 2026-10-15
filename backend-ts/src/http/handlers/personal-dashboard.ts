import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ok } from "../../models/schemas.js";
import { personalDashboard } from "../personal-dashboard.js";
import { HandlerFailure, type CurrentUser, type HandlerServices } from "./common.js";
import type { RepositoryState } from "../../repository/store.js";

const querySchema = z.object({ month: z.string().regex(/^(?:20\d{2}|2100)-(?:0[1-9]|1[0-2])$/), timezone: z.string().min(1).max(100) }).strict();
export async function getPersonalDashboard(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices) {
  // Validate before the availability wrapper so bad input remains a 400.
  const query = personalDashboardQuery(request.query);
  let view;
  try { view = await services.repository.readAuthoritative(state => personalDashboard(state, user, query.month, query.timezone)); }
  catch { throw new HandlerFailure(503, "Your tasks are unavailable until authoritative storage is recovered. No current counts are confirmed."); }
  return reply.send(ok(view, "Saved personal tasks and confirmed schedule dates; no execution authority", null));
}

function personalDashboardQuery(raw: unknown) {
  const query = querySchema.safeParse(raw);
  if (!query.success) throw new HandlerFailure(400, "Choose a calendar month and a valid timezone");
  try { new Intl.DateTimeFormat("en", { timeZone: query.data.timezone }); }
  catch { throw new HandlerFailure(400, "The calendar timezone is invalid"); }
  return query.data;
}

export function projectPersonalDashboard(state: Readonly<RepositoryState>, user: CurrentUser, raw: unknown) {
  const query = personalDashboardQuery(raw);
  return personalDashboard(state, user, query.month, query.timezone);
}
