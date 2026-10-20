import { forwardRef, lazy, Suspense, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import { executionService } from "../../services/execution.service";
import { currentAuthorityEpoch } from "../../utils/authAuthority";
import { useOptionalNotifications } from "../../context/NotificationContext";
import { useChatWorkspace } from "./ChatWorkspaceContext";
const RuntimeApprovalReview = lazy(() => import("../executions/RuntimeApprovalReview"));

// One exact review shared by both panes. Opening/refreshing only reads evidence;
// the existing review component owns explicit, hash-bound decision commands.
const WorkflowRunApproval = forwardRef(function WorkflowRunApproval({ execution, onChanged, autoOpen = false }, ref) {
  const workspace = useChatWorkspace();
  const notifications = useOptionalNotifications();
  const notifiedCheckpoint = useRef(null);
  const workspaceMode = useRef(workspace?.mode); workspaceMode.current = workspace?.mode;
  const [open, setOpen] = useState(false), [frame, setFrame] = useState(null);
  const [location, setLocation] = useState("canvas");
  const [decision, setDecision] = useState(null);
  const panel = useRef(null), controller = useRef(null), generation = useRef(0);
  const epoch = currentAuthorityEpoch(), id = execution?.id;
  const waiting = execution?.status === "AWAITING_APPROVAL";
  const checkpoint = execution?.pendingApproval ? `${execution.pendingApproval.stepId}:${execution.pendingApproval.requestedAt}` : null;
  const lastCheckpoint = useRef(checkpoint);
  const available = Boolean(id && (execution.hasRuntimeApproval || waiting));
  const show = (where = workspace?.mode === "chat" ? "chat" : "canvas") => {
    if (!available) return;
    if (!open) { setFrame(null); setOpen(true); }
    setLocation(where);
  };
  useImperativeHandle(ref, () => ({ open: () => show() }));
  const reload = async () => {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    const version = ++generation.current;
    setFrame({ loading: true });
    try {
      const value = await executionService.getApproval(id, undefined, { signal: request.signal });
      if (request.signal.aborted || version !== generation.current || epoch !== currentAuthorityEpoch()) return;
      const resolved = ["APPROVED", "REJECTED", "CONSUMED", "EXPIRED", "CLOSED"].includes(value.runtimeApproval.state);
      setFrame({ value }); setDecision(current => resolved ? value.runtimeApproval.state : current);
      if (resolved) setOpen(false);
      onChanged?.(); return value;
    } catch (cause) {
      if (request.signal.aborted || version !== generation.current || epoch !== currentAuthorityEpoch()) return;
      setFrame({ error: cause?.response?.data?.message || cause?.message || "Exact review unavailable. Reload before deciding." });
      throw cause;
    }
  };
  useEffect(() => { setOpen(false); setFrame(null); setDecision(null); }, [id, epoch]);
  useEffect(() => {
    if (!waiting || !checkpoint || checkpoint === lastCheckpoint.current) return;
    lastCheckpoint.current = checkpoint;
    controller.current?.abort(); generation.current++;
    setOpen(false); setFrame(null); setDecision(null);
  }, [waiting, checkpoint]);
  useEffect(() => { if (!waiting) { setOpen(false); setDecision(null); } }, [waiting]);
  const notify = notifications?.notify, dismiss = notifications?.dismiss;
  const approvalKey = `${epoch}:${id}:${checkpoint || execution?.runtimeApproval?.id || "pending"}`;
  useEffect(() => {
    if (!autoOpen || !waiting || !available || decision || notifiedCheckpoint.current === approvalKey) return undefined;
    notifiedCheckpoint.current = approvalKey;
    setFrame(null); setLocation(workspaceMode.current === "chat" ? "chat" : "canvas"); setOpen(true);
    const notificationId = notify?.("Human approval needed. The workflow is paused until its exact action is reviewed.", "info", {
      label: "Review approval", onClick: () => {
        if (epoch !== currentAuthorityEpoch()) return;
        setLocation(workspaceMode.current === "chat" ? "chat" : "canvas"); setOpen(true);
      },
    });
    return () => {
      if (notificationId) dismiss?.(notificationId);
      if (notifiedCheckpoint.current === approvalKey) notifiedCheckpoint.current = null;
    };
  }, [autoOpen, waiting, available, decision, approvalKey, epoch, notify, dismiss]);


  useEffect(() => {
    if (!open || !available) return undefined;
    const opener = document.activeElement;
    panel.current?.focus({ preventScroll: true });
    void reload().catch(() => {});
    return () => {
      controller.current?.abort(); generation.current++;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open, id, epoch, available, checkpoint]); // Read a new checkpoint; never replay a decision.

  if (!available || !waiting || decision) return null;
  const summary = location => <section aria-label={`Workflow human approval — ${location}`} className="flex shrink-0 items-center gap-3 border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs dark:border-amber-800 dark:bg-amber-950/30">
    <Icon icon="lucide:hand" className="h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" />
    <div className="min-w-0 flex-1"><p className="font-semibold text-amber-900 dark:text-amber-200">{decision ? `Human review · ${decision.toLowerCase()}` : waiting ? "Human approval needed" : "Transaction review recorded"}</p>
      <p className="mt-0.5 text-[11px] text-gray-600 dark:text-gray-300">{waiting && !decision ? "Run paused. Review the exact action here before deciding." : "A recorded decision is not proof of execution. Check the saved run outcome."}</p></div>
    <button type="button" onClick={() => show(location)} aria-expanded={open && activeLocation === location} className="shrink-0 rounded-md border border-amber-400 px-2.5 py-2 font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900">Review transaction</button>
  </section>;
  // One review follows the visible pane. The notification only opens it;
  // changing panes or receiving a background update never submits a decision.
  const activeLocation = workspace?.mode === "chat" ? "chat" : workspace?.mode === "canvas" ? "canvas" : location;
  const review = open && <section ref={panel} tabIndex={-1} aria-label="Workflow transaction approval" className="max-h-[60dvh] shrink-0 overflow-y-auto border-b border-amber-300 bg-white text-gray-900 focus:outline-none dark:border-amber-800 dark:bg-darkBackground dark:text-white">
    <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2 dark:border-gray-700 dark:bg-darkBackground"><h2 className="text-sm font-semibold">Human approval · review here</h2><button type="button" onClick={() => setOpen(false)} aria-label="Close transaction review" className="rounded-md border px-3 py-2 text-xs font-semibold">{decision ? "Done" : "Close review"}</button></div>
    <div className="p-4">
      {frame?.loading && <p role="status">Loading exact transaction review…</p>}
      {frame?.error && <div role="alert"><p>{frame.error}</p><button type="button" onClick={() => { void reload().catch(() => {}); }} className="mt-3 font-semibold text-primary">Reload review</button></div>}
      {frame?.value && <Suspense fallback={<p role="status">Loading review controls…</p>}><RuntimeApprovalReview key={`${id}:${epoch}:${frame.value.runtimeApproval.id}:${frame.value.runtimeApproval.version}:${frame.value.runtimeApproval.reviewHash}`} execution={frame.value} onReload={reload} onDecisionRecorded={receipt => { setDecision(receipt.state); setOpen(false); onChanged?.(); }} /></Suspense>}
    </div>
  </section>;
  return <>{summary("canvas")}{activeLocation === "canvas" && review}{workspace?.chatReviewHost && createPortal(<>{summary("chat")}{activeLocation === "chat" && review}</>, workspace.chatReviewHost)}</>;
});
export default WorkflowRunApproval;
