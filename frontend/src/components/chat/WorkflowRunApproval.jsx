import { forwardRef, lazy, Suspense, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import { executionService } from "../../services/execution.service";
import { currentAuthorityEpoch } from "../../utils/authAuthority";
import { useChatWorkspace } from "./ChatWorkspaceContext";
const RuntimeApprovalReview = lazy(() => import("../executions/RuntimeApprovalReview"));

// One exact review shared by both panes. Opening/refreshing only reads evidence;
// the existing review component owns explicit, hash-bound decision commands.
const WorkflowRunApproval = forwardRef(function WorkflowRunApproval({ execution, onChanged }, ref) {
  const workspace = useChatWorkspace();
  const [open, setOpen] = useState(false), [frame, setFrame] = useState(null);
  const [decision, setDecision] = useState(null);
  const dialog = useRef(null), controller = useRef(null), generation = useRef(0);
  const epoch = currentAuthorityEpoch(), id = execution?.id;
  const waiting = execution?.status === "AWAITING_APPROVAL";
  const checkpoint = execution?.pendingApproval ? `${execution.pendingApproval.stepId}:${execution.pendingApproval.requestedAt}` : null;
  const lastCheckpoint = useRef(checkpoint);
  const available = Boolean(id && (execution.hasRuntimeApproval || waiting));
  const show = () => { if (available && !open) { setFrame(null); setOpen(true); } };
  useImperativeHandle(ref, () => ({ open: show }));
  const reload = async () => {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    const version = ++generation.current;
    setFrame({ loading: true });
    try {
      const value = await executionService.getApproval(id, undefined, { signal: request.signal });
      if (request.signal.aborted || version !== generation.current || epoch !== currentAuthorityEpoch()) return;
      setFrame({ value }); setDecision(["APPROVED", "REJECTED", "CONSUMED", "EXPIRED", "CLOSED"].includes(value.runtimeApproval.state) ? value.runtimeApproval.state : null); onChanged?.(); return value;
    } catch (cause) {
      if (request.signal.aborted || version !== generation.current || epoch !== currentAuthorityEpoch()) return;
      setFrame({ error: cause?.response?.data?.message || cause?.message || "Exact review unavailable. Reload before deciding." });
      throw cause;
    }
  };
  useEffect(() => {
    if (!open || !available) return undefined;
    const opener = document.activeElement;
    const element = dialog.current;
    if (element?.showModal) element.showModal(); else element?.setAttribute("open", "");
    void reload().catch(() => {});
    return () => {
      controller.current?.abort(); generation.current++;
      element?.close?.();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open, id, epoch, available]); // No poll or decision replay on background updates.
  useEffect(() => { setOpen(false); setFrame(null); setDecision(null); }, [id, epoch]);
  useEffect(() => {
    if (!waiting || !checkpoint || checkpoint === lastCheckpoint.current) return;
    lastCheckpoint.current = checkpoint;
    controller.current?.abort(); generation.current++;
    setOpen(false); setFrame(null); setDecision(null);
  }, [waiting, checkpoint]);

  if (!available) return null;
  const summary = location => <section aria-label={`Workflow human approval — ${location}`} className="flex shrink-0 items-center gap-3 border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs dark:border-amber-800 dark:bg-amber-950/30">
    <Icon icon="lucide:hand" className="h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" />
    <div className="min-w-0 flex-1"><p className="font-semibold text-amber-900 dark:text-amber-200">{decision ? `Human review · ${decision.toLowerCase()}` : waiting ? "Human approval needed" : "Transaction review recorded"}</p>
      <p className="mt-0.5 text-[11px] text-gray-600 dark:text-gray-300">{waiting && !decision ? "Run paused. Review the exact action here before deciding." : "A recorded decision is not proof of execution. Check the saved run outcome."}</p></div>
    <button type="button" onClick={show} className="shrink-0 rounded-md border border-amber-400 px-2.5 py-2 font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900">Review transaction</button>
  </section>;
  const modal = open && <dialog ref={dialog} aria-label="Workflow transaction approval" onCancel={event => { event.preventDefault(); setOpen(false); }} onClose={() => setOpen(false)} className="m-auto max-h-[90dvh] w-[min(48rem,calc(100vw-2rem))] max-w-none overflow-hidden rounded-xl border border-gray-200 bg-white p-0 text-gray-900 shadow-2xl backdrop:bg-black/50 dark:border-gray-700 dark:bg-darkBackground dark:text-white">
    <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-700"><h2 className="text-sm font-semibold">Human approval</h2><button type="button" autoFocus onClick={() => setOpen(false)} aria-label="Close transaction review" className="rounded p-2 hover:bg-primary/10"><Icon icon="lucide:x" /></button></div>
    <div className="max-h-[calc(90dvh-4rem)] overflow-y-auto p-5">
      {frame?.loading && <p role="status">Loading exact transaction review…</p>}
      {frame?.error && <div role="alert"><p>{frame.error}</p><button type="button" onClick={() => { void reload().catch(() => {}); }} className="mt-3 font-semibold text-primary">Reload review</button></div>}
      {frame?.value && <Suspense fallback={<p role="status">Loading review controls…</p>}><RuntimeApprovalReview key={`${id}:${epoch}:${frame.value.runtimeApproval.id}:${frame.value.runtimeApproval.version}:${frame.value.runtimeApproval.reviewHash}`} execution={frame.value} onReload={reload} /></Suspense>}
    </div>
  </dialog>;
  return <>{summary("canvas")}{workspace?.chatReviewHost && createPortal(summary("chat"), workspace.chatReviewHost)}{modal && createPortal(modal, workspace?.reviewDialogHost || document.body)}</>;
});
export default WorkflowRunApproval;
