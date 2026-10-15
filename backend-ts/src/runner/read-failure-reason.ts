import { userMcpFailureCode } from "../tools/user-mcp-failure.js";

/** Bounded diagnostics, never authority or arbitrary upstream exception text. */
export function readFailureReason(cause: unknown): string {
  const credentialCode = userMcpFailureCode(cause);
  if (credentialCode) return credentialCode;
  const message = cause instanceof Error ? cause.message : "";
  if (message.includes("no unique admitted live contract")) return "READ_CAPABILITY_UNAVAILABLE";
  if (message.includes("deterministic verification failed")) return "READ_VALIDATION_FAILED";
  if (message.includes("no valid exact-argument capability")) return "READ_ARGUMENT_CAPABILITY_DENIED";
  if (message.includes("reviewed output schema")) return "READ_OUTPUT_SCHEMA_MISMATCH";
  if (message.includes("optional policy")) return "READ_POLICY_STOPPED";
  if (/context changed|Compiled tool contract changed|connection.*changed|discovery failed/i.test(message)) return "READ_CONTEXT_CHANGED";
  if (/actor.*author|role.*grant|role.*allowed|permission/i.test(message)) return "READ_AUTHORITY_DENIED";
  if (/invalid arguments|arguments failed|unsupported schema/i.test(message)) return "READ_ARGUMENTS_INVALID";
  if (/reply was not confirmed|remote outcome|request failed/i.test(message)) return "READ_REMOTE_UNCONFIRMED";
  return "READ_EXECUTION_FAILED";
}
