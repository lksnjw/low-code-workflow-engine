import { useState } from "react";
import { Icon } from "@iconify/react";
import Card from "../shared/ui/Card";
import Button from "../shared/ui/Button";
import { workflowService } from "../../services/workflow.service";
import { useNotifications } from "../../context/NotificationContext";

/*******************************************************************************
 * Function: PendingGenerationApprovalCard
 *
 * Interactive human-in-the-loop checkpoint shown right in the chat when a
 * just-generated workflow contains one or more `kind: approval` steps.
 * Resolving it here — once, in chat — strips the checkpoint out of the saved
 * YAML, so running this workflow later never pauses to ask again.
 ******************************************************************************/
function PendingGenerationApprovalCard({ pending, onResolved }) {
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [showReject, setShowReject] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState(null);
  const { notify } = useNotifications();

  if (!pending?.workflowId || !Array.isArray(pending.steps) || pending.steps.length === 0) return null;

  const handleApprove = async () => {
    setBusy(true);
    try {
      await workflowService.approveGeneration(pending.workflowId, note);
      notify("Approved — this workflow will now run automatically, with no further approval pauses.", "success");
      setResolved("approved");
      await onResolved?.();
    } catch (error) {
      notify(error?.response?.data?.message || "Could not approve this workflow.", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    setBusy(true);
    try {
      await workflowService.rejectGeneration(pending.workflowId, reason || "Rejected by user");
      notify("Rejected — this workflow will not be used.", "success");
      setResolved("rejected");
      await onResolved?.();
    } catch (error) {
      notify(error?.response?.data?.message || "Could not reject this workflow.", "error");
    } finally {
      setBusy(false);
    }
  };

  if (resolved) {
    return (
      <Card className={`mt-2 border-2 ${resolved === "approved" ? "border-emerald-200 dark:border-emerald-700/60" : "border-red-200 dark:border-red-700/60"}`}>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Icon icon={resolved === "approved" ? "mdi:check-circle" : "mdi:close-circle"} className={`h-5 w-5 ${resolved === "approved" ? "text-emerald-600" : "text-red-600"}`} />
          <span className={resolved === "approved" ? "text-emerald-800 dark:text-emerald-300" : "text-red-800 dark:text-red-300"}>
            {resolved === "approved" ? "Approved — will run autonomously" : "Rejected — not saved for use"}
          </span>
        </div>
      </Card>
    );
  }

  return (
    <Card className="mt-2 border-2 border-amber-300 dark:border-amber-700/60">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-500/15">
          <Icon icon="mdi:account-check-outline" className="h-5 w-5 text-amber-700 dark:text-amber-300" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            This workflow needs approval before it can run
          </p>
          <div className="mt-1 space-y-1">
            {pending.steps.map((step) => (
              <p key={step.stepId} className="text-sm font-semibold text-gray-900 dark:text-white">{step.description}</p>
            ))}
          </div>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
            Do you approve this? Once approved, the workflow runs automatically every time — it will not ask again.
          </p>

          <div className="mt-3">
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note (e.g. approval reference)"
              disabled={busy}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-primary dark:border-gray-700 dark:bg-darkBackground dark:text-white"
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={handleApprove} disabled={busy}>
              <Icon icon="mdi:check" className="h-4 w-4" />
              {busy ? "Working…" : "Approve"}
            </Button>
            <Button variant="secondary" onClick={() => setShowReject((v) => !v)} disabled={busy}>
              <Icon icon="mdi:close" className="h-4 w-4" />
              Reject
            </Button>
          </div>

          {showReject && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800/40 dark:bg-red-900/10">
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason for rejecting"
                disabled={busy}
                className="min-w-[200px] flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-primary dark:border-gray-700 dark:bg-darkBackground dark:text-white"
              />
              <Button
                variant="secondary"
                className="!border-red-300 !bg-red-600 !text-white hover:!bg-red-700 dark:!border-red-700"
                onClick={handleReject}
                disabled={busy}
              >
                Confirm reject
              </Button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

export default PendingGenerationApprovalCard;
