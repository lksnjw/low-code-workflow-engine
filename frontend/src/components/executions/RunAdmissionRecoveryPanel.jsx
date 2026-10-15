export default function RunAdmissionRecoveryPanel({ recovery, execution, onReleased, allowRelease = true }) {
  if (!recovery.pending && !recovery.error) return null;
  return <section aria-label="Original run recovery" className="my-3 space-y-2 rounded-lg border border-amber-200 p-3 text-xs text-gray-700 dark:border-amber-900 dark:text-gray-200">
    <p>{recovery.checking ? "Looking up the original run. No run request is being sent." : "An earlier run request is saved for this account and workflow. Starting another run is locked until its recorded outcome is reviewed."}</p>
    {recovery.error && <p role="alert">{recovery.error}</p>}
    {recovery.run?.admissionNotice && <p>{recovery.run.admissionNotice}</p>}
    <div className="flex flex-wrap gap-3">
      <button type="button" className="font-semibold text-primary" disabled={recovery.checking} onClick={() => void recovery.refresh()}>Recover original run</button>
      <a href="/executions" className="font-semibold text-primary">Review Execution History</a>
      {allowRelease && (["DONE", "FAILED", "CANCELLED"].includes(execution?.status) || execution?.status === "RECOVERY_REQUIRED" && execution.retryAdmission?.canReviewForNewRun === true) && <button type="button" className="font-semibold text-primary" disabled={recovery.checking}
        onClick={async () => { if (await recovery.release(execution)) onReleased?.(); }}>Review complete · enable a new run</button>}
    </div>
  </section>;
}
