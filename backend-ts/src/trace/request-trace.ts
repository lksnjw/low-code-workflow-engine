import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";

const requestTraces = new WeakMap<FastifyRequest, string>();
const tracePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/*******************************************************************************
 * Function: initializeRequestTrace
 *
 * Creates and associates a trace identifier with a request.
 ******************************************************************************/
export function initializeRequestTrace(request: FastifyRequest): string {
  const traceId = randomUUID();
  requestTraces.set(request, traceId);
  return traceId;
}

/*******************************************************************************
 * Function: requestTraceId
 *
 * Reuses a valid linked trace identifier or initializes the request trace.
 ******************************************************************************/
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

/*******************************************************************************
 * Function: isTraceId
 *
 * Checks whether a string matches the accepted trace identifier format.
 ******************************************************************************/
export function isTraceId(value: string): boolean {
  return tracePattern.test(value);
}
