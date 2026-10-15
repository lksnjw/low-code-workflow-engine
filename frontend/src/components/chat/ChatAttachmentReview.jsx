import { useRef, useState } from "react";
import { documentWorkspaceService as service } from "../../services/document-workspace.service";
import { documentReviewIssues } from "./documentReviewValidation";
import { documentNotice } from "../../utils/documentPresentation";

/** Inline source review. Neither model output nor an OK notice grants storage
 * confirmation. A lost confirm reply is reconciled by GET before any retry. */
export default function ChatAttachmentReview({ attachment, indexed, busy, onSaved, initialUpload, initialSchema, onUseForWorkflow }) {
  const [savedUpload, setUpload] = useState(initialUpload ?? null), [schema, setSchema] = useState(initialSchema ?? null), [values, setValues] = useState(initialUpload?.proposal?.rows ?? (initialUpload?.proposal?.fields ? [initialUpload.proposal.fields] : []));
  const [working, setWorking] = useState(false), [error, setError] = useState(""), [checked, setChecked] = useState(false);
  const [uncertainState, setUncertain] = useState(false);
  const [syntheticConfirmed, setSyntheticConfirmed] = useState(false);
  const pending = useRef(false);
  const indexedCurrent = Boolean(indexed?.uploadId && indexed.uploadId === attachment.uploadId);
  // A matching saved receipt is authoritative display input, not a second
  // local state transition or an indexing mutation.
  const upload = indexedCurrent ? { ...savedUpload, status: "READY", document_id: indexed.documentId, version: indexed.version, vector_collection: indexed.collection } : savedUpload;
  const uncertain = !indexedCurrent && uncertainState;
  const blocked = busy || working;
  const rows = values.length ? values : [attachment.fields ?? {}];
  const issues = schema ? documentReviewIssues(schema, rows[0], upload?.proposal?.rows ? rows : null) : [];
  const routes = schema?.collection_routes?.filter(route => route.accepts_uploads && route.document_types?.includes(upload?.proposal?.documentType)) ?? [];
  const destination = routes.length === 1 ? routes[0] : null;
  const destinationUnresolved = Boolean(schema?.collection_routes?.length && !destination);
  const syntheticRequired = destination?.requires_synthetic_confirmation === true;
  const storagePolicyDenied = upload?.status === "INDEX_FAILED" && upload.error_code === "STORAGE_POLICY_DENIED" && !syntheticRequired;
  const run = async work => {
    if (pending.current || busy) return;
    pending.current = true; setWorking(true); setError("");
    try { await work(); } catch (cause) { setError(cause.message || "Document status was not confirmed. Check the saved receipt."); }
    finally { pending.current = false; setWorking(false); }
  };
  const refresh = () => run(async () => {
    let current = await service.get(attachment.sessionId, attachment.uploadId);
    setUpload(current); setChecked(false); setSyntheticConfirmed(false);
    if (current.status === "READY") { setUncertain(false); await onSaved?.(); return; }
    const catalog = await service.catalog();
    if (!current.proposal && catalog.entities?.length && !uncertain && ["REVIEW", "NEEDS_TEXT"].includes(current.status)) {
      current = await service.analyse(attachment.sessionId, attachment.uploadId, { instruction: "Extract this attached business document into the matching entity schema. Leave missing required fields empty; prepare a review only.", createRecord: true, model: attachment.model });
      setUpload(current);
    }
    const matched = catalog.entities?.find(item => item.id === current.proposal?.schemaId);
    setSchema(matched ?? null);
    setValues(current.proposal?.rows ?? [current.proposal?.fields ?? attachment.fields ?? {}]);
    // A non-READY status alone cannot prove a previously dispatched confirm
    // did not happen. Keep unknown confirmations locked until reconciled.
  });
  const confirm = () => run(async () => {
    if (!schema || !upload || !checked || issues.length || uncertain || destinationUnresolved || storagePolicyDenied || syntheticRequired && !syntheticConfirmed) return;
    const body = { expected_revision: upload.revision, schema_id: schema.id, schema_revision: schema.revision,
      document_type: upload.proposal.documentType, create_record: true, review_confirmed: true, extraction_acknowledged: true,
      chat_receipt: true, ...(syntheticRequired ? { synthetic_source_confirmed: syntheticConfirmed } : {}), ...(upload.proposal.rows ? { form_rows: rows } : { form_fields: rows[0] }) };
    try {
      const receipt = await service.confirm(attachment.sessionId, attachment.uploadId, body);
      setUpload(receipt); setChecked(false); if (receipt.status === "READY") await onSaved?.();
    } catch (cause) { setUncertain(true); throw cause; }
  });
  const recover = () => run(async () => {
    // This fences an old pipeline attempt, never resubmits indexing or an ERP
    // write. The server checks age, current revision and reservation ownership.
    if (!upload || !["INDEXING", "EXTRACTION_FAILED"].includes(upload.status)) return;
    const receipt = await service.recover(attachment.sessionId, attachment.uploadId, upload.revision);
    setUpload(receipt); setChecked(false); setUncertain(false);
  });
  return <section aria-label="Attached document" className="mt-3 space-y-3 rounded-xl border border-gray-200 p-3 text-xs dark:border-gray-700">
    <div className="flex flex-wrap items-start justify-between gap-2"><p className="break-all font-semibold">{attachment.filename}</p><span className="text-gray-500">{upload?.status === "READY" ? "Searchable" : upload?.id || attachment.storage === "STAGED" ? "Uploaded · review before indexing" : "Provisional reading · storage not confirmed"}</span></div>
    <p>{attachment.summary}</p>
    {upload?.status !== "READY" && !!attachment.warnings?.length && <details><summary className="cursor-pointer text-amber-700 dark:text-amber-300">Initial reading notes</summary><p className="mt-1 text-gray-500">Recorded during initial reading; check the current document status before continuing.</p>{attachment.warnings.map((warning, index) => <p key={index} className="text-amber-700 dark:text-amber-300">{documentNotice(warning, attachment.model)}</p>)}</details>}
    {upload?.id && upload.status !== "READY" && attachment.storage !== "STAGED" && <p role="status" className="text-emerald-700 dark:text-emerald-300">The original upload has now been found in the pipeline. Earlier preview warnings describe its initial state; review and confirm before indexing.</p>}
    {!attachment.uploadId && <p className="text-amber-700 dark:text-amber-300">The pipeline was unavailable. These observations can be discussed in chat, but no vector save or later retrieval is confirmed. Keep the original file.</p>}
    {attachment.uploadId && <button type="button" disabled={blocked} onClick={refresh} className="rounded-lg border px-3 py-1.5 font-semibold disabled:opacity-50">{working ? "Checking document…" : "Check document & review fields"}</button>}
    {upload?.status === "READY" ? <div role="status" className="space-y-1 text-emerald-700 dark:text-emerald-300"><p>Saved and searchable · no original ERP record was created.</p><p className="break-all">Document: {upload.document_id} · v{upload.version}</p><p className="break-all">Collection: {upload.vector_collection}</p><p>Continue in chat to retrieve its details or request a reviewed ERP change.</p></div> : upload && <>
      {upload.status === "INDEX_FAILED" && <div role="alert" className="space-y-1 text-red-700 dark:text-red-300">
        <p className="font-semibold">Document indexing failed · not searchable</p>
        <p>{storagePolicyDenied ? "The storage policy requires an approved on-premises vector location for restricted documents. This deployment cannot index this medical or restricted file. Ask an administrator to configure an approved destination; do not relabel it as an ordinary document." : "The pipeline kept the upload, but did not confirm vector indexing. Check the original document status and resolve the indexing problem before confirming again."}</p>
        <p>No ERP record was created. The original upload is retained.</p>
      </div>}
      {["EXTRACTING", "INDEXING"].includes(upload.status) && <p role="status">{upload.status === "EXTRACTING" ? "OCR is still preparing the source. Continue chatting and check this document again." : "Indexing is not yet confirmed. Check the original receipt; do not submit another confirmation."}</p>}
      {["INDEXING", "EXTRACTION_FAILED"].includes(upload.status) && <div className="space-y-2"><p>After five minutes, an interrupted indexing attempt can be recovered for a fresh review. Active work is protected by the server.</p><button type="button" disabled={blocked} onClick={recover} className="rounded-lg border px-3 py-1.5 font-semibold disabled:opacity-50">Recover interrupted processing</button></div>}
      {!schema && !working && <p>No schema-bound review is available yet. Use Document library to retry preparation, or ask an administrator to import the entity schema. Do not upload another copy.</p>}
      {schema && <>
        <p className="text-gray-500">{schema.source_system_id} / {schema.source_entity} · {upload.proposal?.documentType}. Review these values against the original file. This saves only to the pipeline.</p>
        {destination && <div aria-label="Detected document destination" className="space-y-1 border-l-2 border-primary pl-3">
          <p className="font-semibold">{destination.tier === "restricted" ? "Restricted document collection" : "Entity document collection"} · {schema.source_entity}</p>
          {destination.description && <p>{destination.description}</p>}
          <p className="text-gray-500">The registered schema selects this destination. It is not an ERP record or an active governing policy.</p>
          <details><summary className="cursor-pointer text-primary">Collection details</summary><p className="mt-1 break-all">{destination.collection}</p></details>
        </div>}
        {destinationUnresolved && <p role="alert" className="text-amber-700 dark:text-amber-300">The registered schema does not identify one permitted destination for this document type. Review the record type before saving; no collection will be guessed.</p>}
        {syntheticRequired && <label className="flex items-start gap-2"><input type="checkbox" disabled={blocked || uncertain} checked={syntheticConfirmed} onChange={event => { setSyntheticConfirmed(event.target.checked); setChecked(false); }} />This file contains no real personal or medical information.</label>}
        {rows.map((row, index) => <fieldset key={index} disabled={blocked || uncertain} className="grid min-w-0 gap-2 sm:grid-cols-2">
          {rows.length > 1 && <legend>Record {index + 1}</legend>}
          {schema.fields.map(field => <label key={field.name} className="block">{field.name.replace(/_/g, " ")}{field.required && !field.generated ? " *" : ""}
            {field.type === "boolean" ? <select aria-label={`Document ${index + 1} ${field.name}`} value={row[field.name] == null ? "" : String(row[field.name])} className="mt-1 w-full rounded border bg-transparent p-2" onChange={event => { setValues(rows.map((item, at) => at === index ? { ...item, [field.name]: event.target.value === "" ? null : event.target.value === "true" } : item)); setChecked(false); }}><option value="">Not supplied</option><option value="true">Yes</option><option value="false">No</option></select> :
              <input aria-label={`Document ${index + 1} ${field.name}`} value={row[field.name] ?? ""} type={["number", "integer"].includes(field.type) ? "number" : field.type === "date" ? "date" : field.type === "email" ? "email" : "text"} className="mt-1 w-full rounded border bg-transparent p-2" onChange={event => { const raw = event.target.value, value = raw === "" ? null : ["number", "integer"].includes(field.type) ? Number(raw) : raw; setValues(rows.map((item, at) => at === index ? { ...item, [field.name]: value } : item)); setChecked(false); }} />}
          </label>)}
        </fieldset>)}
        {issues.length > 0 && <div role="status" className="text-amber-700 dark:text-amber-300"><p>Complete these fields before saving:</p><ul className="list-disc pl-4">{issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div>}
        <label className="flex items-start gap-2"><input type="checkbox" disabled={blocked || uncertain} checked={checked} onChange={event => setChecked(event.target.checked)} />I checked the extracted fields against the original. Save this reviewed document to the pipeline only.</label>
        <button type="button" disabled={blocked || uncertain || !checked || issues.length > 0 || destinationUnresolved || storagePolicyDenied || syntheticRequired && !syntheticConfirmed || ["EXTRACTING", "INDEXING", "EXTRACTION_FAILED", "SUPERSEDED"].includes(upload.status)} onClick={confirm} className="rounded-lg bg-primary px-3 py-2 font-semibold text-white disabled:opacity-40">Confirm & save document</button>
      </>}
    </>}
    {uncertain && <p role="alert">The storage confirmation was not received. Check document status before taking another action; this confirmation will not be blindly repeated.</p>}
    {upload?.status === "READY" && upload.document_id && onUseForWorkflow && <button type="button" disabled={blocked} onClick={() => onUseForWorkflow({ uploadId: attachment.uploadId, documentId: upload.document_id, version: upload.version, purpose: "erp_record_proposal" })} className="rounded-lg border border-primary px-3 py-2 font-semibold text-primary disabled:opacity-40">Create customer or record workflow</button>}
    {error && <p role="alert" className="text-red-700 dark:text-red-300">{documentNotice(error, attachment.model)}</p>}
  </section>;
}
