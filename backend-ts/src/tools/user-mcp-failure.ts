import { HandlerFailure } from "../http/handlers/common.js";

const notices = {
  ERP_USER_CREDENTIAL_REQUIRED: "Add your own ERPBridge token in Profile → My ERP connections, test it, then start a new request.",
  ERP_USER_CREDENTIAL_CHANGED: "Your ERPBridge token changed. Check Profile → My ERP connections and start a new request; the old request was not rebound to another token.",
  ERP_USER_BINDING_REQUIRED: "This request has no original ERP credential binding. Check Profile → My ERP connections and start a new request.",
  ERP_USER_CONNECTION_FAILED: "Your ERPBridge token could not connect. Test it in Profile → My ERP connections and check its validity and permissions.",
  ERP_ACTOR_UNAVAILABLE: "Your ERP access is no longer active or your platform role changed. Ask your platform administrator to review your access.",
  ERP_CREDENTIAL_INVALID: "Your saved ERP connection requires administrator attention. No shared administrator token was substituted.",
  ERP_CREDENTIAL_UNAVAILABLE: "ERP credential storage is unavailable. No shared administrator token was substituted.",
} as const;
export type UserMcpFailureCode = keyof typeof notices;

/** Only application-owned failures may produce credential guidance. Never
 * classify a remote JSON envelope or exception text as local authority. */
export function userMcpFailureCode(cause: unknown): UserMcpFailureCode | undefined {
  if (!(cause instanceof HandlerFailure) || !cause.meta || typeof cause.meta !== "object") return undefined;
  const code = (cause.meta as Record<string, unknown>).code;
  return typeof code === "string" && Object.hasOwn(notices, code) ? code as UserMcpFailureCode : undefined;
}
export function userMcpFailureNotice(code: UserMcpFailureCode): string { return notices[code]; }
