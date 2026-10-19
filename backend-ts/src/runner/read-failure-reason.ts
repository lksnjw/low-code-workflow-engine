import { OperationDeadlineExceeded } from "../core/bounded-operation.js";
import { userMcpFailureCode, userMcpFailureNotice } from "../tools/user-mcp-failure.js";

/** Bounded diagnostics, never authority or arbitrary upstream exception text. */
export function readFailureReason(cause: unknown): string {
  const credentialCode = userMcpFailureCode(cause);
  if (credentialCode) return credentialCode;
  if (cause instanceof OperationDeadlineExceeded) return "READ_TOOL_TIMEOUT";
  const message = cause instanceof Error ? cause.message : "";
  if (message === "Workflow input does not meet the declared schema") return "READ_ARGUMENTS_INVALID";
  if (message === "Read workflow does not meet the supported execution profile") return "READ_VALIDATION_FAILED";
  if (message === "Compiled data reference is unavailable") return "READ_REFERENCE_UNAVAILABLE";
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

/** Safe public explanations; never reflect arbitrary ERP exception contents. */
export function readFailureDiagnostic(cause: unknown) {
  const code = readFailureReason(cause);
  const credentialCode = userMcpFailureCode(cause);
  if (credentialCode) return { code, stage: "authentication", message: userMcpFailureNotice(credentialCode), retryable: false };
  const notices: Record<string, { stage: string; message: string }> = {
    READ_REFERENCE_UNAVAILABLE: { stage: "input_resolution", message: "A required workflow input or prior step output is missing. Check this step's data mappings." },
    READ_TOOL_TIMEOUT: { stage: "tool_execution", message: "The ERP tool did not respond before the deadline. Its remote outcome is unconfirmed; no automatic retry was performed." },
    READ_VALIDATION_FAILED: { stage: "validation", message: "The workflow does not match its current supported execution contract." },
    READ_ARGUMENTS_INVALID: { stage: "input_validation", message: "The resolved step inputs do not match the registered tool schema." },
    READ_CAPABILITY_UNAVAILABLE: { stage: "tool_resolution", message: "The referenced tool is not currently available with a unique admitted contract." },
    READ_AUTHORITY_DENIED: { stage: "authorization", message: "Current account permissions do not allow this step." },
    READ_OUTPUT_SCHEMA_MISMATCH: { stage: "output_validation", message: "The ERP response does not match the reviewed output schema." },
    READ_CONTEXT_CHANGED: { stage: "tool_resolution", message: "The ERP connection or tool contract changed. Check the connection and review this workflow." },
  };
  return { code, ...(notices[code] ?? { stage: "execution", message: "The step failed or was blocked. Inspect its recorded execution evidence." }), retryable: false };
}
