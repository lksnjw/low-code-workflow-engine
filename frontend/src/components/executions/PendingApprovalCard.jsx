import { useState } from "react";
import { Icon } from "@iconify/react";
import Card from "../shared/ui/Card";
import Button from "../shared/ui/Button";
import { executionService } from "../../services/execution.service";
import { useNotifications } from "../../context/NotificationContext";

/*******************************************************************************
 * Function: PendingApprovalCard
 *
 * Interactive human-in-the-loop checkpoint. Shown when an execution is
 * paused waiting for a person to approve or reject the step the agent
 * stopped at. Approving resumes the same agent run from where it stopped —
 * it does not restart the workflow or re-ask about steps already done.
 ******************************************************************************/
function PendingApprovalCard({ execution, onChanged }) {
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [showReject, setShowReject] = useState(false);
  const [busy, setBusy] = useState(false);
  const { notify } = useNotifications();

  const pending = execution.pendingApproval;
  if (!pending) return null;

  const handleApprove = async () => {
    setBusy(true);
    try {
      const updated = await executionService.approve(execution.id, note);
      notify(
        updated.status === "AWAITING_APPROVAL"
          ? "Approved — workflow reached another approval checkpoint."
          : "Approved — workflow resumed and completed.",
        "success",
      );
      await onChanged?.();
    } catch (error) {
      notify(error?.response?.data?.message || "Could not approve this step.", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    setBusy(true);
    try {
      await executionService.reject(execution.id, reason || "Rejected by user");
      notify("Rejected — the workflow will not continue.", "success");
      await onChanged?.();
    } catch (error) {
      notify(error?.response?.data?.message || "Could not reject this step.", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-2 border-amber-300 dark:border-amber-700/60">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-500/15">
          <Icon icon="mdi:account-check-outline" className="h-5 w-5 text-amber-700 dark:text-amber-300" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            Human approval needed
          </p>
          <p className="mt-1 text-sm font-semibold text-gray-900 dark:text-white">{pending.description}</p>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">Do you approve this?</p>

          {execution.approvals?.length > 0 && (
            <p className="mt-2 text-xs text-gray-400">
              Already approved: {execution.approvals.map((a) => `"${a.stepId}" by ${a.approvedBy.name}`).join(", ")}
            </p>
          )}

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

export default PendingApprovalCard;
