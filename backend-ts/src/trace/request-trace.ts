import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";

const requestTraces = new WeakMap<FastifyRequest, string>();
const tracePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function initializeRequestTrace(request: FastifyRequest): string {
  const traceId = randomUUID();
  requestTraces.set(request, traceId);
  return traceId;
}

export function requestTraceId(
  request: FastifyRequest,
  linkedTraceId?: string,
): string {
  if (linkedTraceId !== undefined && isTraceId(linkedTraceId)) {
    requestTraces.set(request, linkedTraceId);
    return linkedTraceId;
  }
  const existing = requestTraces.get(request);
  return existing ?? initializeRequestTrace(request);
}

export function isTraceId(value: string): boolean {
  return tracePattern.test(value);
}
