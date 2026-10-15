import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import Button from "../shared/ui/Button";
import { documentWorkspaceService as service } from "../../services/document-workspace.service";
import { documentReviewIssues } from "./documentReviewValidation";
import { documentNotice } from "../../utils/documentPresentation";

const EXTENSIONS = ".pdf,.png,.jpg,.jpeg,.tif,.tiff,.txt,.csv,.tsv,.json,.docx,.xlsx";
const control = "w-full rounded-lg border border-gray-300 bg-transparent p-2 text-xs dark:border-gray-600";
const labels = { EXTRACTING: "Preparing document", EXTRACTION_FAILED: "Extraction needs attention", REVIEW: "Waiting for review", NEEDS_TEXT: "No readable text", INDEXING: "Indexing — refresh for receipt", INDEX_FAILED: "Index failed — file kept", INTERRUPTED: "Interrupted — file kept", READY: "Searchable", SUPERSEDED: "Older version" };

/** Private drafts stay in component memory, never browser storage. */
export default function ChatAttachments({ sessionId, model, disabled, onCreateChat, onUseForWorkflow, onUseModelPreview, canAuthorWorkflows = false, workflowInstruction = "", openRequestKey = 0 }) {
  const [open, setOpen] = useState(false), [items, setItems] = useState([]), [schemas, setSchemas] = useState([]), [inventory, setInventory] = useState(null);
  const [selected, setSelected] = useState(null), [schemaId, setSchemaId] = useState(""), [type, setType] = useState("");
  const [instruction, setInstruction] = useState(""), [createRecord, setCreateRecord] = useState(true), [fields, setFields] = useState({}), [choiceId, setChoiceId] = useState("");
  const [reviewed, setReviewed] = useState(false), [acknowledged, setAcknowledged] = useState(false), [share, setShare] = useState(false), [versionId, setVersionId] = useState("");
  const [batchRows, setBatchRows] = useState(null);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [pendingFile, setPendingFile] = useState(null);
  const [uploadUnconfirmed, setUploadUnconfirmed] = useState(false);
  const [modelAssist, setModelAssist] = useState(true);
  const [workflowOutcome, setWorkflowOutcome] = useState(""), [prepareSchedule, setPrepareSchedule] = useState(false);
  const [modelPreview, setModelPreview] = useState(null), [previewBusy, setPreviewBusy] = useState(false), [previewError, setPreviewError] = useState(""), [previewReviewed, setPreviewReviewed] = useState(false);
  const [previewFilename, setPreviewFilename] = useState("");
  const previewAttempt = useRef(null);
  const inFlight = useRef(false), mounted = useRef(true), uploadIdentity = useRef(null), currentSession = useRef({ id: sessionId }), pendingAnalysis = useRef(null);
  if (currentSession.current.id !== sessionId) currentSession.current = { id: sessionId };
  const sessionScope = currentSession.current;
  const isCurrent = () => mounted.current && currentSession.current === sessionScope;
  const clearPreview = () => {
    if (previewAttempt.current) { previewAttempt.current.cancelled = true; clearTimeout(previewAttempt.current.timer); }
    previewAttempt.current = null; setModelPreview(null); setPreviewBusy(false); setPreviewError(""); setPreviewReviewed(false); setPreviewFilename("");
  };
  useEffect(() => {
    setSelected(null); setItems([]); setPendingFile(null); setUploadUnconfirmed(false); setError(""); setNotice(""); setBusy(""); setFields({}); setBatchRows(null);
    setInstruction(""); setSchemaId(""); setType(""); setChoiceId(""); setReviewed(false); setAcknowledged(false); setShare(false); setVersionId("");
    setWorkflowOutcome(""); setPrepareSchedule(false);
    if (previewAttempt.current) { previewAttempt.current.cancelled = true; clearTimeout(previewAttempt.current.timer); }
    previewAttempt.current = null; setModelPreview(null); setPreviewBusy(false); setPreviewError(""); setPreviewReviewed(false); setPreviewFilename("");
    inFlight.current = false; pendingAnalysis.current = null; uploadIdentity.current = null;
  }, [sessionId]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (previewAttempt.current) { previewAttempt.current.cancelled = true; clearTimeout(previewAttempt.current.timer); } }; }, []);
  useEffect(() => {
    if (modelAssist) return;
    pendingAnalysis.current = null;
    if (previewAttempt.current) { previewAttempt.current.cancelled = true; clearTimeout(previewAttempt.current.timer); }
    setPreviewBusy(false);
  }, [modelAssist]);
  useEffect(() => { if (openRequestKey > 0) setOpen(true); }, [openRequestKey]);
  const schema = schemas.find(item => item.id === schemaId);
  const destination = schema?.collection_routes?.find(route => route.accepts_uploads && route.document_types.includes(type));
  const fieldIssues = createRecord ? documentReviewIssues(schema, fields, batchRows) : [];
  const blocked = disabled || Boolean(busy);
  const adopt = value => {
    setSelected(value); setReviewed(false); setAcknowledged(false); setShare(false); setVersionId("");
    if (value.proposal) {
      const proposal = value.proposal; setSchemaId(proposal.schemaId); setType(proposal.documentType); setFields(proposal.fields ?? {});
      setCreateRecord(proposal.createRecord); setChoiceId("");
      setBatchRows(proposal.rows ?? null);
    } else { setFields({}); setChoiceId(""); setBatchRows(null); }
  };
  const load = async () => {
    const [catalog, summary, uploads] = await Promise.all([service.catalog(), service.inventory(), sessionId ? service.list(sessionId) : Promise.resolve({ items: [] })]);
    if (!isCurrent()) return;
    setSchemas(catalog.entities ?? []); setInventory(summary); setItems(uploads.items ?? []);
    if (selected) {
      const refreshed = uploads.items.find(item => item.id === selected.id);
      if (refreshed) {
        if (refreshed.revision !== selected.revision) { setReviewed(false); setAcknowledged(false); }
        setSelected(current => current && refreshed.revision < current.revision ? current : ({ ...current, ...refreshed }));
      }
    }
    return uploads.items ?? [];
  };
  const run = async (label, work) => {
    if (inFlight.current || disabled) return;
    const operation = Symbol("document-operation");
    inFlight.current = operation; setBusy(label); setError(""); setNotice("");
    const handoff = setTimeout(() => { if (isCurrent()) setNotice("Still processing. You can continue chatting; this document has not been confirmed."); }, 10000);
    try { await work(); }
    catch (cause) { if (isCurrent()) cause.code === "ATTACHMENT_PROCESSING" ? setNotice(cause.message) : setError(cause.message || "The document operation failed. Refresh to check its receipt."); }
    finally { clearTimeout(handoff); if (inFlight.current === operation) { inFlight.current = false; if (isCurrent()) setBusy(""); } }
  };
  useEffect(() => {
    if (!open || disabled) return;
    let active = true;
    Promise.all([service.catalog(), service.inventory(), sessionId ? service.list(sessionId) : Promise.resolve({ items: [] })])
      .then(([catalog, summary, uploads]) => { if (active) { setSchemas(catalog.entities ?? []); setInventory(summary); setItems(uploads.items ?? []); } })
      .catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [open, sessionId, disabled]);
  useEffect(() => {
    if (!sessionId || selected?.status !== "EXTRACTING") return;
    let active = true, timer, polls = 0;
    const poll = async () => {
      try {
        const next = await service.get(sessionId, selected.id);
        if (!active || !isCurrent()) return;
        if (next.revision > selected.revision) { setReviewed(false); setAcknowledged(false); }
        setItems(current => current.map(item => item.id === next.id ? next : item));
        setSelected(current => current?.id === next.id && next.revision >= current.revision ? { ...current, ...next } : current);
        if (next.status === "EXTRACTING" && ++polls < 40) timer = setTimeout(poll, 2500);
        else if (next.status !== "EXTRACTING") setNotice(next.status === "EXTRACTION_FAILED" ? "Document preparation needs attention. The file is kept privately." : "Document preparation finished. Review the fields before confirming.");
      } catch { if (active && isCurrent()) setError("Could not refresh document status. Refresh before confirming or uploading again."); }
    };
    timer = setTimeout(poll, 2500);
    return () => { active = false; clearTimeout(timer); };
  }, [sessionId, selected?.id, selected?.status]);
  useEffect(() => {
    if (!pendingAnalysis.current || selected?.status !== "REVIEW" || busy || disabled) return;
    const pending = pendingAnalysis.current;
    if (pending.uploadId !== selected.id) return;
    pendingAnalysis.current = null;
    if (previewAttempt.current?.started) return;
    if (previewAttempt.current) { previewAttempt.current.primary = true; clearTimeout(previewAttempt.current.timer); }
    void run("Preparing review…", async () => { const result = await service.analyse(sessionId, selected.id, pending.body); if (isCurrent()) adopt(result); });
  }, [selected?.status, selected?.id, busy, disabled]);
  const upload = () => run("Uploading…", async () => {
    if (!pendingFile || !sessionId) return;
    if (!EXTENSIONS.split(",").some(extension => pendingFile.name.toLowerCase().endsWith(extension))) throw new Error("Unsupported file type. Use one of the listed formats.");
    if (!pendingFile.size || pendingFile.size > 16 * 1024 * 1024) throw new Error("Choose a non-empty file up to 16 MiB.");
    const file = pendingFile;
    pendingAnalysis.current = null;
    if (previewAttempt.current) { previewAttempt.current.cancelled = true; clearTimeout(previewAttempt.current.timer); }
    setModelPreview(null); setPreviewReviewed(false); setPreviewError("");
    const attempt = { cancelled: false, started: false, primary: false, timer: null, promise: null };
    previewAttempt.current = attempt;
    const previewEligible = modelAssist && model && file.size <= 4 * 1024 * 1024 && /\.(pdf|png|jpe?g|txt|csv|tsv|json)$/i.test(file.name);
    const startPreview = () => {
      if (attempt.cancelled || attempt.primary || !isCurrent() || previewAttempt.current !== attempt || !previewEligible) return Promise.resolve();
      if (attempt.started) return attempt.promise;
      attempt.started = true; clearTimeout(attempt.timer); setPreviewBusy(true); setPreviewError("");
      setNotice("Preparing a document preview while storage is checked separately. You can continue chatting.");
      attempt.promise = (async () => {
        try {
          const result = await service.preview(sessionId, file, { model, instruction: instruction.trim() || workflowInstruction.trim() });
          if (isCurrent() && previewAttempt.current === attempt && !attempt.cancelled) { setModelPreview(result); setPreviewFilename(file.name); setPreviewReviewed(false); }
        } catch (cause) { if (isCurrent() && previewAttempt.current === attempt && !attempt.cancelled) setPreviewError(cause.message || "Document preview is unavailable. Wait for document preparation or ask an administrator."); }
        finally { if (isCurrent() && previewAttempt.current === attempt && !attempt.cancelled) setPreviewBusy(false); }
      })();
      return attempt.promise;
    };
    if (previewEligible) attempt.timer = setTimeout(() => { void startPreview(); }, 10000);
    let receipt;
    try { receipt = await service.stage(sessionId, file, uploadIdentity.current); }
    catch (cause) {
      const unavailable = cause.unavailable || cause.status >= 500 || ["PIPELINE_UNAVAILABLE", "PIPELINE_UNREACHABLE", "PIPELINE_TIMEOUT"].includes(cause.code);
      if (isCurrent() && unavailable && !(cause.status >= 400 && cause.status < 500)) setUploadUnconfirmed(true);
      if (unavailable && previewEligible && !(cause.status >= 400 && cause.status < 500)) {
        await startPreview();
        if (isCurrent()) setError("Pipeline storage was not confirmed. The document preview is not indexed; refresh the attachment list before retrying storage with this same upload request.");
        return;
      }
      attempt.cancelled = true; clearTimeout(attempt.timer); throw cause;
    }
    if (!isCurrent()) return;
    adopt(receipt); setPendingFile(null); setUploadUnconfirmed(false); uploadIdentity.current = null;
    setItems(current => [receipt, ...current.filter(item => item.id !== receipt.id)]);
    setNotice("Uploaded privately. Review its association before indexing.");
    if (modelAssist && model && schemas.length) {
      const body = { instruction: instruction.trim() || "Extract the registration or business document fields for review. Do not create an ERP record or workflow.", createRecord, model, ...(schemaId ? { schemaId } : {}) };
      if (receipt.status === "EXTRACTING") pendingAnalysis.current = { uploadId: receipt.id, body };
      else if (!attempt.started) {
        attempt.primary = true; clearTimeout(attempt.timer);
        try { const result = await service.analyse(sessionId, receipt.id, body); if (isCurrent()) adopt(result); }
        catch (cause) {
          if (!isCurrent()) return;
          if (cause.code !== "ATTACHMENT_PROCESSING") throw cause;
          pendingAnalysis.current = { uploadId: receipt.id, body: { ...body, preferExtractedText: true } }; setNotice(cause.message);
        }
      }
    }
    if (isCurrent()) await load();
  });
  const confirm = () => run("Confirming & indexing…", async () => {
    if (!selected || !schema || !reviewed || fieldIssues.length) return;
    const document = inventory?.documents?.find(item => item.id === versionId);
    const result = await service.confirm(sessionId, selected.id, { expected_revision: selected.revision, schema_id: schema.id, schema_revision: schema.revision,
      document_type: type, create_record: createRecord, form_fields: createRecord && !batchRows ? fields : {}, ...(createRecord && batchRows ? { form_rows: batchRows } : {}), ...(!createRecord ? { choiceId } : {}),
      mode: versionId ? "version" : "new", ...(document ? { document_id: document.id, document_revision: document.revision } : {}),
      review_confirmed: true, extraction_acknowledged: acknowledged, share_with_schema_roles: share });
    if (!isCurrent()) return;
    setSelected(current => ({ ...current, ...result })); setReviewed(false);
    setNotice(result.status === "READY" ? `Searchable. ${result.pipeline_record_id ? versionId ? "Document version indexed; existing pipeline record retained. No original ERP record was changed." : "Pipeline record created; no original ERP record was created." : "ERP association verified; no original ERP record was changed."}` : "The file is kept, but indexing was not confirmed. Refresh and explicitly retry.");
    await load();
  });
  return <section className="mb-2 text-xs text-gray-700 dark:text-gray-200" aria-label="Chat documents">
    <button type="button" className="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-800" aria-expanded={open} disabled={disabled} onClick={() => setOpen(value => !value)}>
      <Icon icon="mdi:paperclip" className="h-4 w-4" /> Documents &amp; forms <Icon icon={open ? "mdi:chevron-up" : "mdi:chevron-down"} />
    </button>
    {open && <div className="mt-2 max-h-[55vh] space-y-3 overflow-y-auto border-y border-gray-200 py-3 dark:border-gray-700">
      <div className="flex items-center justify-between gap-2"><p className="font-semibold">Upload → review → index</p><Button variant="ghost" disabled={blocked} onClick={() => run("Refreshing…", load)}>Refresh</Button></div>
      <p className="text-gray-500">Files stay private until reviewed. Original ERP creation is not performed here.</p>
      {!sessionId ? <Button disabled={blocked} onClick={() => run("Creating conversation…", onCreateChat)}>Start document conversation</Button> : <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1">Attachment (up to 16 MiB)<input aria-label="Choose chat attachment" className="mt-1 block w-full text-xs" type="file" accept={EXTENSIONS} disabled={blocked} onChange={event => {
          clearPreview(); setPendingFile(event.target.files?.[0] ?? null); setUploadUnconfirmed(false); uploadIdentity.current = crypto.randomUUID(); setError("");
        }} /></label><Button disabled={blocked || !pendingFile} onClick={upload}>{uploadUnconfirmed ? "Retry same upload request" : "Upload privately"}</Button>
      </div>}
      {uploadUnconfirmed && <div aria-label="Unconfirmed document upload" className="space-y-2 border-l-2 border-amber-400 pl-3">
        <p className="font-semibold">Upload confirmation needs checking</p>
        <p className="leading-5">The file may already be stored. Check its saved status, then select the original attachment below. A document preview or OK acknowledgement does not confirm storage.</p>
        <Button variant="secondary" disabled={blocked} onClick={() => run("Checking upload status…", async () => {
          const uploads = await load();
          if (isCurrent()) setNotice(uploads?.length ? "Saved attachments loaded. Select the original attachment and review its status before continuing." : "No saved attachment was found yet. If you retry, use Retry same upload request to keep the original request identity.");
        })}>Check upload status</Button>
        <p className="text-[11px] text-gray-500">Checking status only reads receipts. Retrying uses the same file and request identity; it never confirms indexing or creates an ERP record.</p>
      </div>}
      <p className="text-[11px] text-gray-500">PDF, PNG, JPEG, TIFF, text, CSV/TSV, JSON, DOCX and XLSX. OCR availability affects scanned files; macros are not run.</p>
      <label className="flex items-start gap-2"><input type="checkbox" checked={modelAssist} disabled={blocked} onChange={event => setModelAssist(event.target.checked)} />Prepare a document preview automatically. After 10 seconds of delay, background reading can prepare provisional fields while OCR continues. Review is always required.</label>
      <p className="text-[11px] text-gray-500">Document preview: PDF, PNG, JPEG and UTF-8 text/CSV/TSV/JSON up to 4 MiB. OCR and storage status are checked separately; a preview does not confirm either.</p>
      {previewBusy && <p role="status">Reading document… OCR/storage status is tracked separately. You can continue chatting.</p>}
      {previewError && <p role="alert" className="text-amber-700 dark:text-amber-300">{documentNotice(previewError, model)}</p>}
      {modelPreview && <div aria-label="Provisional document preview" className="space-y-2 border-l-2 border-primary pl-3">
        <p className="font-semibold">Document preview · source review required</p>
        <p className="break-words text-[11px] text-gray-500">{previewFilename}</p>
        <p>{modelPreview.summary}</p>
        <p className="text-[11px] text-gray-500">This preview does not confirm OCR, pipeline storage, vector indexing or ERP creation. Any accepted pipeline upload continues independently; if the pipeline is offline, OCR/storage cannot run there.</p>
        <details><summary className="cursor-pointer">Review interpreted fields and rows</summary><pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words text-[11px]">{JSON.stringify({ fields: modelPreview.fields, rows: modelPreview.rows, missingInformation: modelPreview.missingInformation, warnings: modelPreview.warnings?.map(warning => documentNotice(warning, modelPreview.model)) }, null, 2)}</pre></details>
        {onUseModelPreview && <>
          <label className="flex items-start gap-2"><input type="checkbox" checked={previewReviewed} disabled={disabled} onChange={event => setPreviewReviewed(event.target.checked)} />I checked these provisional values against the original file. They are not a storage receipt.</label>
          <Button variant="secondary" disabled={disabled || !previewReviewed} onClick={() => onUseModelPreview(modelPreview, { instruction: workflowOutcome.trim() || instruction.trim() || workflowInstruction.trim(), asWorkflow: false })}>Use reviewed preview in chat</Button>
          {canAuthorWorkflows && <Button variant="secondary" disabled={disabled || !previewReviewed} onClick={() => onUseModelPreview(modelPreview, { instruction: workflowOutcome.trim() || instruction.trim() || workflowInstruction.trim(), asWorkflow: true, prepareSchedule })}>Prepare workflow request from preview</Button>}
          <p className="text-[11px] text-gray-500">These actions fill the chat composer. Review and send the request; ERP writes and schedules are never started here.</p>
        </>}
      </div>}
      {inventory && <p role="status">{inventory.counts_complete ? "" : "Bounded inventory: "}{inventory.searchable_documents} permitted searchable document(s) · {inventory.pending_review} owned pending · updated {new Date(inventory.as_of).toLocaleTimeString()}</p>}
      {items.length > 0 && <label className="block">Uploaded in this conversation<select className={`${control} mt-1`} value={selected?.id ?? ""} disabled={blocked} onChange={event => run("Opening…", async () => {
        clearPreview(); if (!event.target.value) { setSelected(null); return; } const result = await service.get(sessionId, event.target.value); if (isCurrent()) adopt(result);
      })}><option value="">Choose an attachment</option>{items.map(item => <option key={item.id} value={item.id}>{item.filename} — {labels[item.status] ?? item.status}</option>)}</select></label>}
      {selected && <div className="space-y-3 border-t border-gray-200 pt-3 dark:border-gray-700">
        <p className="font-semibold">{selected.filename} · {labels[selected.status] ?? selected.status}</p>
        {selected.status === "EXTRACTING" && <p role="status">Preparing your document in the background. You can continue chatting.</p>}
        {selected.status === "EXTRACTION_FAILED" && <Button variant="secondary" disabled={blocked} onClick={() => run("Retrying document preparation…", async () => { const result = await service.recover(sessionId, selected.id, selected.revision); if (isCurrent()) adopt(result); })}>Retry document preparation</Button>}
        {selected.document_id && <p className="break-all text-[11px]">Document: {selected.document_id}{selected.version ? ` · version ${selected.version}` : ""}</p>}
        {selected.vector_collection && <p className="break-all text-[11px]">Indexed collection: {selected.vector_collection}</p>}
        {selected.pipeline_record_id && <p className="break-all text-[11px]">Pipeline record: {selected.pipeline_record_id}</p>}
        {selected.pipeline_record_ids?.length > 1 && <p>{selected.pipeline_record_ids.length} reviewed member records stored in the pipeline database.</p>}
        {selected.status === "READY" && onUseForWorkflow && <div className="space-y-2" aria-label="Document workflow handoff">
          <label className="block">Workflow request<textarea className={`${control} mt-1`} maxLength={2000} value={workflowOutcome} disabled={blocked} placeholder="Add these reviewed clients to the ERP, check duplicates and show missing mandatory fields." onChange={event => setWorkflowOutcome(event.target.value)} /></label>
          <label className="flex items-start gap-2"><input type="checkbox" checked={prepareSchedule} disabled={blocked} onChange={event => setPrepareSchedule(event.target.checked)} />Also assess scheduling requirements</label>
          <p className="text-[11px] text-gray-500">Prepares a request in chat. Send it to draft on the canvas, then review, publish and confirm execution separately. Scheduling requires a supported workflow and explicit activation; this is not a live file watcher.</p>
          <Button variant="secondary" disabled={blocked} onClick={() => {
            const context = { uploadId: selected.id, documentId: selected.document_id, version: selected.version, purpose: "erp_record_proposal" };
            const outcome = workflowOutcome.trim() || instruction.trim() || workflowInstruction.trim();
            if (outcome || prepareSchedule) onUseForWorkflow(context, { instruction: outcome, prepareSchedule }); else onUseForWorkflow(context);
          }}>Use reviewed data for ERP workflow</Button>
        </div>}
        {selected.extracted_text && <details><summary className="cursor-pointer">Review extracted text</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words bg-gray-50 p-2 dark:bg-gray-900">{selected.extracted_text}</pre></details>}
        {selected.warnings?.map((warning, index) => <p key={index} className="text-amber-700 dark:text-amber-300">{warning}</p>)}
        {!["READY", "SUPERSEDED", "INDEXING"].includes(selected.status) && <>
          <label className="block">Record destination<select className={`${control} mt-1`} value={createRecord ? "pipeline" : "erp"} disabled={blocked} onChange={event => { setCreateRecord(event.target.value === "pipeline"); setChoiceId(""); setReviewed(false); }}><option value="pipeline">Create a reviewed pipeline record</option><option value="erp">Link an existing ERP record (read-only lookup)</option></select></label>
          <label className="block">Entity schema<select className={`${control} mt-1`} value={schemaId} disabled={blocked} onChange={event => { setSchemaId(event.target.value); setType(""); setFields({}); setBatchRows(null); setChoiceId(""); setReviewed(false); }}><option value="">Choose source / entity</option>{schemas.map(item => <option key={item.id} value={item.id}>{item.source_system_id} / {item.source_entity} · revision {item.revision}</option>)}</select></label>
          {!schemas.length && <p>Ask an administrator to import an entity schema in Files &amp; Documents.</p>}
          <label className="block">Tell the assistant what to do<textarea className={`${control} mt-1`} value={instruction} maxLength={2000} disabled={blocked} placeholder="Find member Jane by name and attach this leave note, or extract this registration form." onChange={event => setInstruction(event.target.value)} /></label>
          <Button variant="secondary" disabled={blocked || !instruction.trim() || !model || !schemas.length} onClick={() => run("Analysing & verifying…", async () => {
            const result = await service.analyse(sessionId, selected.id, { instruction, createRecord, model, ...(schemaId ? { schemaId } : {}) }); if (isCurrent()) { adopt(result); await load(); }
          })}>Ask assistant to prepare review</Button>
          <p className="text-[11px] text-gray-500">Automatic document analysis requires administrator-approved processing access. You can also review pipeline form fields manually.</p>
          {selected.proposal?.summary && <p>{selected.proposal.summary}</p>}
          {!createRecord && <label className="block">Verified ERP match (choose explicitly)<select className={`${control} mt-1`} disabled={blocked} value={choiceId} onChange={event => { setChoiceId(event.target.value); setReviewed(false); }}><option value="">Choose a verified record</option>{(selected.proposal?.choices ?? []).filter(choice => choice.schemaId === schemaId).map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</select></label>}
          {schema && <>
            <label className="block">Document type<select className={`${control} mt-1`} value={type} disabled={blocked} onChange={event => { setType(event.target.value); setReviewed(false); }}><option value="">Choose document type</option>{schema.document_types.map(value => <option key={value}>{value}</option>)}</select></label>
            {destination && <div aria-label="Upload collection destination" className="space-y-1 border-l-2 border-primary pl-3"><p className="font-semibold">{destination.source_system_id} / {destination.source_entity} · {destination.tier === "restricted" ? "Restricted · owner only" : "Standard collection"}</p><p className="break-all font-mono text-[11px]">{destination.collection}</p><p className="text-gray-500">{destination.description} · {destination.searchable_documents} permitted current document(s). The server verifies this destination when you confirm.</p></div>}
            {type && schema.collection_routes && !destination && <p role="alert">No valid collection destination is available. Refresh the schema before confirming.</p>}
            {createRecord && <label className="flex items-center gap-2"><input type="checkbox" disabled={blocked} checked={Boolean(batchRows)} onChange={event => { setBatchRows(event.target.checked ? [{}] : null); setReviewed(false); }} />Review multiple members (up to 50)</label>}
            {createRecord && batchRows && <BatchReview rows={batchRows} schema={schema} disabled={blocked} onChange={value => { setBatchRows(value); setReviewed(false); }} />}
            {createRecord && !batchRows && <fieldset className="space-y-2" disabled={blocked}><legend className="mb-2 font-semibold">Reviewed form fields</legend>{schema.fields.map(field => <label className="block" key={field.name}>{field.name}{field.required && !field.generated ? " *" : ""}{field.generated ? " (optional generated key)" : ""}
              {field.type === "boolean" ? <select className={`${control} mt-1`} value={fields[field.name] === undefined ? "" : String(fields[field.name])} onChange={event => { setFields(current => ({ ...current, [field.name]: event.target.value === "" ? null : event.target.value === "true" })); setReviewed(false); }}><option value="">Not supplied</option><option value="true">Yes</option><option value="false">No</option></select> :
                <input className={`${control} mt-1`} value={fields[field.name] ?? ""} type={["integer", "number"].includes(field.type) ? "number" : field.type === "date" ? "date" : field.type === "email" ? "email" : "text"} step={field.type === "integer" ? "1" : "any"} onChange={event => { const value = event.target.value; setFields(current => ({ ...current, [field.name]: value === "" ? null : ["number", "integer"].includes(field.type) ? Number(value) : value })); setReviewed(false); }} />}</label>)}</fieldset>}
            <label className="block">Document version<select className={`${control} mt-1`} disabled={blocked} value={versionId} onChange={event => { setVersionId(event.target.value); setReviewed(false); }}><option value="">New document (does not replace another)</option>{(inventory?.documents ?? []).filter(item => item.schema_id === schema.id && item.document_type === type && item.current_upload_id && !item.pending_upload_id).map(item => <option key={item.id} value={item.id}>New version of {item.id} (v{item.version})</option>)}</select></label>
            {schema.reader_roles?.length > 0 && !["medical_certificate", "medical_record", "identity_document"].includes(type) && schema.minimum_sensitivity !== "restricted" && <label className="flex items-center gap-2"><input type="checkbox" checked={share} disabled={blocked} onChange={event => { setShare(event.target.checked); setReviewed(false); }} />Share with schema-approved roles: {schema.reader_roles.join(", ")}</label>}
          </>}
          {selected.warnings?.length > 0 && <label className="flex items-center gap-2"><input type="checkbox" checked={acknowledged} disabled={blocked} onChange={event => setAcknowledged(event.target.checked)} />I reviewed the extraction warnings.</label>}
          <label className="flex items-start gap-2"><input type="checkbox" checked={reviewed} disabled={blocked} onChange={event => setReviewed(event.target.checked)} />I checked the source, record association, document type and fields. Confirm storage in the pipeline only.</label>
          {fieldIssues.length > 0 && <div role="status" aria-label="Document fields needing attention" className="space-y-1 border-l-2 border-amber-400 pl-3 text-amber-800 dark:text-amber-200"><p className="font-semibold">Complete these fields before confirming</p><ul className="list-disc pl-4">{fieldIssues.slice(0, 10).map(issue => <li key={issue}>{issue}</li>)}</ul>{fieldIssues.length > 10 && <p>{fieldIssues.length - 10} more field issue(s). Check every row before confirming.</p>}</div>}
          <Button disabled={blocked || ["EXTRACTING", "EXTRACTION_FAILED"].includes(selected.status) || !schema || !type || !reviewed || fieldIssues.length > 0 || (schema?.collection_routes && !destination) || (!createRecord && !choiceId) || (selected.warnings?.length > 0 && !acknowledged) || !inventory?.vector_index_configured} onClick={confirm}>{["INDEX_FAILED", "INTERRUPTED"].includes(selected.status) ? "Retry reviewed indexing" : "Confirm & index"}</Button>
          {!reviewed && <p className="text-gray-500">Check the source-review box above to enable confirmation after all required fields are complete.</p>}
          {!inventory?.vector_index_configured && <p>Vector indexing is unavailable. The attachment is kept for review.</p>}
        </>}
        {selected.status === "INDEXING" && <Button variant="secondary" disabled={blocked} onClick={() => run("Recovering…", async () => { const result = await service.recover(sessionId, selected.id, selected.revision); if (isCurrent()) { setSelected(result); await load(); } })}>Recover if interrupted (after 5 minutes)</Button>}
      </div>}
      {busy && <p role="status">{busy} Do not repeat the operation.</p>}{notice && <div className="flex items-start gap-3"><p role="status" className="min-w-0 flex-1 text-primary dark:text-fuchsia-300">{documentNotice(notice, model)}</p>{!busy && <button type="button" aria-label="Acknowledge document update" onClick={() => setNotice("")} className="shrink-0 rounded-md border px-3 py-1 font-semibold">OK</button>}</div>}{error && <p role="alert" className="text-red-700 dark:text-red-300">{documentNotice(error, model)}</p>}
    </div>}
  </section>;
}

function BatchReview({ rows, schema, disabled, onChange }) {
  return <div className="space-y-2"><p className="font-semibold">Review every member · {rows.length} row(s)</p><p className="text-gray-500">Duplicate supplied keys and missing required fields block the whole batch. No ERP members or login accounts are created.</p>
    <div className="max-h-64 overflow-auto"><table className="w-full text-left text-xs"><thead><tr><th className="p-1">Row</th>{schema.fields.map(field => <th className="p-1" key={field.name}>{field.name}{field.required && !field.generated ? " *" : ""}</th>)}<th className="p-1">Action</th></tr></thead><tbody>{rows.map((row, index) => <tr key={index}><td className="p-1">{index + 1}</td>{schema.fields.map(field => <td className="min-w-32 p-1" key={field.name}>{field.type === "boolean" ? <select className={control} aria-label={`Row ${index + 1} ${field.name}`} disabled={disabled} value={row[field.name] === undefined || row[field.name] === null ? "" : String(row[field.name])} onChange={event => onChange(rows.map((value, at) => at === index ? { ...value, [field.name]: event.target.value === "" ? null : event.target.value === "true" } : value))}><option value="">Not supplied</option><option value="true">Yes</option><option value="false">No</option></select> : <input className={control} aria-label={`Row ${index + 1} ${field.name}`} disabled={disabled} type={["integer", "number"].includes(field.type) ? "number" : field.type === "date" ? "date" : field.type === "email" ? "email" : "text"} step={field.type === "integer" ? "1" : "any"} value={row[field.name] ?? ""} onChange={event => onChange(rows.map((value, at) => at === index ? { ...value, [field.name]: event.target.value === "" ? null : ["integer", "number"].includes(field.type) ? Number(event.target.value) : event.target.value } : value))} />}</td>)}<td className="p-1"><button type="button" className="underline disabled:opacity-50" disabled={disabled || rows.length < 2} aria-label={`Remove row ${index + 1}`} onClick={() => onChange(rows.filter((_, at) => at !== index))}>Remove</button></td></tr>)}</tbody></table></div>
    <Button variant="secondary" disabled={disabled || rows.length >= 50} onClick={() => onChange([...rows, {}])}>Add review row</Button>
  </div>;
}
