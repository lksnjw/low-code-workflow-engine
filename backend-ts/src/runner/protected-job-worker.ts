import type { HandlerServices } from "../http/handlers/common.js";
import { withUserMcpBinding } from "../tools/user-mcp-credentials.js";
import { publicExecution } from "../redact/public-model-usage.js";
import { ProtectedJobCheckpoints } from "./protected-job-checkpoints.js";

/** Internal owned worker. Normal publication/queue activation stays closed
 * until every required driver and its durability campaign are qualified. */
export async function runProtectedOperation(services: HandlerServices, executionId: string) {
  const original = await services.repository.readAuthoritative(state => state.executions[executionId]);
  return withUserMcpBinding(services, original?.startedBy.id ?? "", original?.erpCredentialSecret, () => runBound(services, executionId));
}
async function runBound(services: HandlerServices, executionId: string) {
  const checkpoints = await ProtectedJobCheckpoints.claim(services, executionId);
  if (checkpoints) {
    try {
      await checkpoints.initialize();
      for (;;) {
        const point = await checkpoints.next(); if (!point) break;
        if (!point.valid) throw new Error("Protected execution reached an invalid structural boundary");
        if (point.kind === "action") await checkpoints.executeAction(); else await checkpoints.advanceControl(point);
      }
    } catch (error) {
      // If persistence itself is unavailable, stop must fail too: do not report
      // a fabricated terminal commit or replay an uncertain in-flight call.
      await checkpoints.stop();
    } finally { checkpoints.close(); }
  }
  return services.repository.readAuthoritative(state => {
    const run = state.executions[executionId]; if (!run) throw new Error("Protected run disappeared");
    return publicExecution(run);
  });
}
