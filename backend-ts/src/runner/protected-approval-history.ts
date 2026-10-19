import type { Execution } from "../repository/store.js";
import type { CompiledProtectedOperationPlan } from "../workflows/protected-operation-compiler.js";
import { ProtectedMachine } from "../workflows/protected-machine.js";
import { protectedJournalHash as hash } from "../repository/protected-invocation-records.js";
import { assertProtectedApprovalRecords } from "../repository/protected-approval-records.js";
import { validateToolInput } from "../tools/tool-input-schema.js";

/** Original semantic replay, separate from current approver/dispatch authority.
 * Called only after the full private continuation binding is authenticated.
 * This optional DATA foundation does not enable an effect/approval driver. */
export function assertProtectedApprovalHistory(plan: CompiledProtectedOperationPlan, run: Execution): void {
  const records = run.protectedApprovalSecret; if (!records) return;
  const ledger = run.protectedInvocationSecret!; assertProtectedApprovalRecords(records, ledger);
  const bySequence = new Map(Object.values(records.records).map(record => [record.binding.sequence, record]));
  const replay = new ProtectedMachine(plan.machine, run.workflowSnapshot!.input); replay.peek();
  for (let at = 0; at <= ledger.nextSequence; at++) {
    const record = bySequence.get(at), point = replay.peek();
    if (record) {
      const b = record.binding, node = plan.ir.root.nodes.find(item => item.id === b.nodeId);
      if (!point?.valid || point.kind !== "action" || node?.kind !== "action" || node.effectClass === "read" ||
          b.pointHash !== hash(point) || b.nodeHash !== hash(node) || b.argumentHash !== hash(point.arguments) ||
          hash(b.admission) !== hash(node.capability.admission)) throw new Error("Protected approval does not reproduce its original exact item and compiled effect");
      const intent = ledger.intents[b.intentKey], receipt = record.sdkReceipt, contract = plan.ir.contracts[node.capability.toolId];
      if (intent?.state === "ACKNOWLEDGED" && !receipt) throw new Error("Owned protected effect lacks private SDK receipt history");
      if (intent?.state === "ACKNOWLEDGED" && at < ledger.nextSequence) {
        const result = ledger.receipts[String(at)]?.result, output = result?.kind === "accept" ? result.output : undefined;
        const generic = contract?.operationContract?.confirmation.source === "mcp-envelope";
        let confirmation: unknown = generic ? output : (output as { structuredContent?: unknown } | undefined)?.structuredContent;
        for (const part of contract?.operationContract?.confirmation.path ?? [])
          confirmation = confirmation && typeof confirmation === "object" && !Array.isArray(confirmation) && Object.hasOwn(confirmation, part)
            ? (confirmation as Record<string, unknown>)[part] : undefined;
        if (!receipt || !contract?.operationContract || receipt.remoteName !== node.capability.remoteName || receipt.meaning !== contract.operationContract.confirmation.meaning ||
            !output || hash(output) !== receipt.outputHash || validateToolInput(contract.outputSchema, (output as Record<string, unknown>)[generic ? "jsonContent" : "structuredContent"]).length ||
            confirmation !== contract.operationContract.confirmation.expected)
          throw new Error("Owned protected effect lacks exact contract-confirmed private SDK receipt history");
      }
    }
    if (at < ledger.nextSequence) {
      const result = ledger.receipts[String(at)]!.result;
      if (result.kind === "accept") replay.accept(result.output); else replay.fail(result.fault);
      replay.peek();
    }
  }
}
