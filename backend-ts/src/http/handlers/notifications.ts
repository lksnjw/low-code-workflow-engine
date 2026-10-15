import type { FastifyReply, FastifyRequest } from "fastify";
import { fail, ok } from "../../models/schemas.js";
import type { RouteDefinition } from "../generated-routes.js";
import { paginate, queryRecord, requestParam, type CurrentUser, type HandlerServices } from "./common.js";

export const NOTIFICATION_UNHANDLED = Symbol("notification-unhandled");

/** Owns the notification collection and acknowledgement mutations. */
export async function handleNotificationRoute(
  route: RouteDefinition,
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown | typeof NOTIFICATION_UNHANDLED> {
  const base = `${services.config.apiBasePath}/notifications`;
  if (route.path === `${base}/read-all` && route.method === "PATCH") return markAllRead(reply, user, services);
  if (route.path === `${base}/:id/read` && route.method === "PATCH") return markRead(request, reply, user, services);
  if (route.path === `${base}/:id` && route.method === "DELETE") return remove(request, reply, user, services);
  if (route.path === base && route.method === "GET") return listNotifications(request, reply, user, services);
  return NOTIFICATION_UNHANDLED;
}

function belongsTo(item: Record<string, unknown>, user: CurrentUser): boolean {
  const owners = [item.recipientId, item.userId, item.ownerId].filter(value => typeof value === "string" && value.length > 0);
  return owners.length > 0 && owners.every(value => value === user.id);
}

export async function listNotifications(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: { repository: Pick<HandlerServices["repository"], "read"> }): Promise<unknown> {
  const unreadOnly = [true, "true"].includes(queryRecord(request).unreadOnly as boolean | string);
  const all = await services.repository.read((state) => Object.values(state.notifications).filter(item => belongsTo(item, user) && (!unreadOnly || item.read !== true)).map((item) => structuredClone(item)));
  all.sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")));
  const page = paginate(all, request);
  return reply.send(ok(page.items, "OK", page.meta));
}

async function markRead(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const updated = await services.repository.mutate((state) => {
    const item = state.notifications[requestParam(request, "id")];
    if (item === undefined || !belongsTo(item, user)) return null;
    item.read = true; item.readAt = new Date().toISOString();
    return structuredClone(item);
  });
  if (updated === null) return reply.status(404).send(fail("Notification not found", null));
  return reply.send(ok(updated, "Marked as read", null));
}

async function remove(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const existed = await services.repository.mutate((state) => {
    const id = requestParam(request, "id");
    if (state.notifications[id] === undefined || !belongsTo(state.notifications[id], user)) return false;
    delete state.notifications[id]; return true;
  });
  return reply.send(ok({ deleted: existed }, "Notification deleted", null));
}

async function markAllRead(reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const timestamp = new Date().toISOString();
  const count = await services.repository.mutate((state) => {
    let updated = 0;
    for (const item of Object.values(state.notifications)) if (belongsTo(item, user) && item.read !== true) {
      item.read = true; item.readAt = timestamp; updated += 1;
    }
    return updated;
  });
  return reply.send(ok({ markedRead: count }, "All notifications marked read", null));
}
