import { useEffect, useRef, useState } from "react";
import { workflowService } from "../../services/workflow.service";
import WorkflowDialog from "./WorkflowDialog";
import WorkflowRunInputs from "./WorkflowRunInputs";
import WorkflowDocumentInput from "./WorkflowDocumentInput";
import { workflowRunInputIssues } from "./workflowRunInput";
import Button from "../shared/ui/Button";
import { workflowRunGuidance, workflowRunHelpMessage } from "./workflowRunGuidance";

export default function WorkflowRunDialog(props) {
  return props.open ? <WorkflowRunReview key={props.workflowId} {...props} /> : null;
}

function WorkflowRunReview({ workflowId, initialRecord, onClose, onRun, onHelp, onReview, onReadinessChanged, beforeInputs, inline = false, disabled = false, error = "" }) {
  // Mount a new review on each opening. Later prop refreshes cannot replace entered values.
  const [opening] = useState(() => ({ workflowId, record: initialRecord }));
  const [frame, setFrame] = useState(() => initialRecord ? { record: initialRecord } : null), [input, setInput] = useState({}), [parseErrors, setParseErrors] = useState({}), [starting, setStarting] = useState(false), [checking, setChecking] = useState(!initialRecord), [notice, setNotice] = useState("");
  const inFlight = useRef(false), generation = useRef(0);
  const [documentGate, setDocumentGate] = useState({ selected: false, ready: false }), [documentReviewed, setDocumentReviewed] = useState(false);
  const changeInput = value => { setInput(value); setDocumentReviewed(false); };
  useEffect(() => {
    const epoch = ++generation.current;
    if (!opening.record) workflowService.readiness(opening.workflowId).then(record => { if (generation.current === epoch) setFrame({ record }); }).catch(cause => { if (generation.current === epoch) setFrame({ error: cause?.response?.data?.message || cause?.message || "Could not check current run requirements." }); }).finally(() => { if (generation.current === epoch) setChecking(false); });
    return () => { generation.current = epoch + 1; };
  }, [opening]);
  const record = frame?.record, schema = record?.authoring?.inputSchema;
  const issues = [...workflowRunInputIssues(schema || { type: "object" }, input), ...Object.values(parseErrors).filter(Boolean)];
  const blockers = workflowRunGuidance(record);
  const blocked = disabled || starting || checking || !record || record.can_attempt_run !== true || issues.length > 0 || documentGate.selected && (!documentGate.ready || !documentReviewed);
  const refresh = async () => {
    if (checking || starting) return;
    const epoch = generation.current; setChecking(true); setNotice("");
    try { const next = await workflowService.readiness(workflowId); if (generation.current === epoch) {
      if (JSON.stringify(next.authoring?.inputSchema) !== JSON.stringify(schema)) { setInput({}); setParseErrors({}); setDocumentGate({ selected: false, ready: false }); setDocumentReviewed(false); }
      setFrame({ record: next }); onReadinessChanged?.(next);
    } }
    catch (cause) { if (generation.current === epoch) setFrame({ error: cause?.response?.data?.message || cause?.message || "Could not check current run requirements." }); }
    finally { if (generation.current === epoch) setChecking(false); }
  };
  const Container = inline ? CanvasInputPanel : WorkflowDialog;
  return <Container open title="Run workflow" onClose={onClose} busy={starting}>
    {beforeInputs}
    {!frame ? <p role="status">Checking current workflow inputs…</p> : frame.error ? <div className="space-y-3"><p role="alert">{frame.error} No run was sent.</p><Button variant="secondary" onClick={refresh} disabled={checking}>{checking ? "Checking…" : "Check again"}</Button></div> : <form className="space-y-4" noValidate onSubmit={async event => {
      event.preventDefault(); if (blocked || inFlight.current) return;
      const epoch = generation.current; inFlight.current = true; setStarting(true); setNotice("");
      try { const result = await onRun(input); if (generation.current !== epoch) return; if (result?.id) onClose(); else setNotice("The run was not confirmed. Review its status before trying again."); }
      catch (cause) { if (generation.current === epoch) setNotice(cause?.message || "The run was not confirmed. Check its original receipt before another run."); }
      finally { inFlight.current = false; if (generation.current === epoch) setStarting(false); }
    }}>
      <p className="text-sm text-gray-600 dark:text-gray-300">{record.name || "Saved workflow"} · {record.publishedVersion > 0 ? `Published version ${record.publishedVersion}` : "Draft awaiting publication"}. Fill the required fields, then start this run. Configured ERP approvals still apply.</p>
      {blockers.length > 0 && <section aria-label="What to fix before running" className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"><p role="alert" className="font-semibold">This workflow is not ready to run. Here is what needs attention:</p><ul className="list-disc space-y-2 pl-5">{blockers.map((reason, index) => <li key={index}>{reason}</li>)}</ul><div className="flex flex-wrap gap-2">{onHelp && <Button variant="secondary" disabled={starting || checking} onClick={() => onHelp(workflowRunHelpMessage(record, issues))}>Help me fix this in chat</Button>}{onReview && <Button variant="secondary" disabled={starting || checking} onClick={onReview}>Review steps and publication</Button>}<Button variant="secondary" disabled={starting || checking} onClick={refresh}>{checking ? "Checking…" : "Check again"}</Button></div><p className="text-xs">The chat action prepares a message for you to review and send.</p></section>}
      {record.approval_setup_required && <div className="space-y-2 text-sm"><p>No transaction has been started. Reviewers must be configured before an ERP-changing run can begin.</p>{record.can_manage_approval_policy ? <a href="/settings" className="inline-block font-semibold text-primary underline underline-offset-4">Configure transaction reviewers in Settings</a> : <p>Ask your administrator to configure transaction reviewers in Settings.</p>}</div>}
      {schema?.type === "object" && Object.keys(schema.properties || {}).length > 0 && <WorkflowDocumentInput key={JSON.stringify(schema)} schema={schema} workflowName={record.name} disabled={starting || checking || disabled} onReset={() => { changeInput({}); setParseErrors({}); }} onPrepared={values => { changeInput(values); setParseErrors({}); }} onGate={gate => { setDocumentGate(gate); setDocumentReviewed(false); }} />}
      {schema ? <WorkflowRunInputs schema={schema} value={input} onChange={changeInput} disabled={starting || checking || disabled} onError={(path, value) => setParseErrors(current => ({ ...current, [path]: value }))} /> : <><p className="text-sm text-gray-500">{record.can_attempt_run ? "No business inputs are required for this run." : "This draft has no declared input fields. The assistant can help complete the draft before running it."}</p>{record.can_attempt_run === true && <details><summary className="cursor-pointer text-xs text-primary">Advanced input</summary><div className="mt-2"><WorkflowRunInputs value={input} onChange={changeInput} disabled={starting || checking || disabled} onError={(path, value) => setParseErrors(current => ({ ...current, [path]: value }))} /></div></details>}</>}
      {documentGate.selected && <label className="flex items-start gap-2 text-sm"><input type="checkbox" aria-label="I checked these inputs against the source document" disabled={starting || checking || !documentGate.ready || issues.length > 0} checked={documentReviewed} onChange={event => setDocumentReviewed(event.target.checked)} />I checked these inputs against the source document. Run still uses the current workflow permissions and approvals.</label>}
      {issues.length > 0 && <div role="status" aria-label="Required run inputs" className="border-l-2 border-amber-400 pl-3 text-xs text-amber-800 dark:text-amber-200"><ul className="list-disc space-y-1 pl-4">{issues.slice(0, 12).map((issue, index) => <li key={index}>{issue}</li>)}</ul></div>}
      {!blockers.length && onHelp && issues.length > 0 && <Button variant="secondary" disabled={starting || checking} onClick={() => onHelp(workflowRunHelpMessage(record, issues))}>Ask the assistant about these inputs</Button>}
      {(error || notice) && <p role="alert" className="text-sm text-amber-700">{[error, notice].filter(Boolean).join(" ")}</p>}
      <div className="flex justify-end gap-2 border-t border-gray-200 pt-4 dark:border-gray-700"><Button variant="secondary" disabled={starting} onClick={onClose}>Cancel</Button><Button type="submit" disabled={blocked}>{starting ? "Starting…" : "Start workflow"}</Button></div>
    </form>}
  </Container>;
}

function CanvasInputPanel({ children, onClose, busy }) {
  const panel = useRef(null);
  useEffect(() => { const opener = document.activeElement; panel.current?.focus(); return () => { if (opener?.isConnected) opener.focus?.(); }; }, []);
  return <section ref={panel} tabIndex={-1} aria-label="Canvas workflow inputs" aria-busy={busy} className="absolute inset-0 z-30 flex min-h-0 flex-col bg-white text-gray-900 outline-none dark:bg-darkBackground dark:text-gray-100">
    <header className="flex shrink-0 items-start justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700"><div><h2 className="text-sm font-semibold">Inputs &amp; documents</h2><p className="mt-1 text-xs text-gray-500">Prepare this run here. Uploading or filling fields does not run the workflow.</p></div><button type="button" disabled={busy} aria-label="Close canvas inputs" onClick={onClose} className="rounded-md border px-3 py-2 text-xs disabled:opacity-50">Close</button></header>
    <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
  </section>;
}
