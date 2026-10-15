import { useEffect, useRef, useState } from "react";
import { chatService } from "../../services/chat.service";
import { documentWorkspaceService as documents } from "../../services/document-workspace.service";
import Button from "../shared/ui/Button";
import { documentInputInstruction, documentInputProposal, mergeDocumentInputProposals } from "./workflowDocumentMapping";
import { documentNotice } from "../../utils/documentPresentation";

/** Private source preparation only. No ERP call, indexing confirmation or run
 * is dispatched here. Each file keeps its original upload identity. */
export default function WorkflowDocumentInput({ schema, workflowName, disabled, onReset, onPrepared, onGate }) {
  const [expanded, setExpanded] = useState(false), [files, setFiles] = useState([]), [models, setModels] = useState(null), [model, setModel] = useState("");
  const [session, setSession] = useState(null), [results, setResults] = useState([]), [receipts, setReceipts] = useState([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [sameRecord, setSameRecord] = useState(false), [readingIndex, setReadingIndex] = useState(0);
  const epoch = useRef(0), pending = useRef(false), uploadKeys = useRef([]), preparedCache = useRef([]), sessionKey = useRef(crypto.randomUUID());
  useEffect(() => () => { epoch.current++; }, []);
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    chatService.models().then(catalog => { if (active) { setModels(catalog); setModel(catalog.binding?.model || ""); } })
      .catch(() => { if (active) setError("Document reading is unavailable. You can still enter run inputs manually."); });
    return () => { active = false; };
  }, [expanded]);
  const clear = () => { epoch.current++; setFiles([]); setResults([]); setReceipts([]); setSameRecord(false); preparedCache.current = []; setError(""); onReset(); onGate({ selected: false, ready: false }); };
  const choose = event => {
    const chosen = Array.from(event.target.files || []);
    if (!chosen.length) return;
    clear();
    if (chosen.length > 6 || chosen.reduce((sum, file) => sum + file.size, 0) > 16 * 1024 * 1024 || chosen.some(file => !file.size || !/\.(pdf|png|jpe?g|tiff?|txt|csv|tsv|json|docx|xlsx)$/i.test(file.name))) {
      event.target.value = ""; setError("Choose up to six supported, non-empty documents, at most 16 MiB in total."); return;
    }
    setFiles(chosen); uploadKeys.current = chosen.map(() => crypto.randomUUID()); onGate({ selected: true, ready: false });
  };
  const complete = files.length > 0 && results.length === files.length && results.every(Boolean);
  const prepare = async () => {
    if (pending.current || disabled || !files.length || complete || !models?.configured) return;
    const current = epoch.current; pending.current = true; setBusy(true); setError("");
    try {
      const conversation = session || await chatService.createSession(`Run input: ${workflowName || "Workflow"}`.slice(0, 100), { idempotencyKey: sessionKey.current });
      if (current !== epoch.current) return;
      setSession(conversation);
      for (let index = 0; index < files.length; index++) {
        if (current !== epoch.current) return;
        if (preparedCache.current[index]) continue;
        setReadingIndex(index + 1);
        const prepared = await documents.prepare(conversation.id, files[index], { idempotencyKey: uploadKeys.current[index], model, instruction: documentInputInstruction(schema), saveToConversation: true });
        if (current !== epoch.current) return;
        preparedCache.current[index] = prepared;
        setResults([...preparedCache.current]);
        setReceipts(previous => { const next = [...previous]; next[index] = prepared.upload || null; return next; });
      }
    } catch (cause) {
      if (current === epoch.current) setError(cause.status === 503 || cause.code === "FUNCTIONS_INVOCATION_UNCONFIRMED"
        ? "Document reading was not confirmed. The server may be busy with another request. Open the source conversation to check progress, then use Read document to recover the same upload. You can also remove the document and enter the fields manually."
        : cause.message || "Document preparation was not confirmed. Check its source conversation before retrying.");
    }
    finally { pending.current = false; if (current === epoch.current) setBusy(false); }
  };
  const refresh = async () => {
    if (pending.current || !session || !results.some(result => result?.attachment?.uploadId)) return;
    const current = epoch.current; pending.current = true; setBusy(true); setError("");
    try { for (let index = 0; index < results.length; index++) {
      if (!results[index]?.attachment?.uploadId) continue;
      const next = await documents.get(session.id, results[index].attachment.uploadId);
      if (current !== epoch.current) return;
      setReceipts(previous => { const updated = [...previous]; updated[index] = next; return updated; });
    } }
    catch (cause) { if (current === epoch.current) setError(cause.message); }
    finally { pending.current = false; if (current === epoch.current) setBusy(false); }
  };
  const proposal = complete ? files.length === 1 ? { ...documentInputProposal(schema, results[0].attachment), blocked: !!results[0].attachment.rows?.length } : mergeDocumentInputProposals(schema, results.map(result => result.attachment)) : null;
  return <section aria-label="Document run inputs" className="space-y-3 border-y border-gray-200 py-4 text-sm dark:border-gray-700">
    {!expanded ? <Button variant="secondary" disabled={disabled} onClick={() => setExpanded(true)}>Fill inputs from a document</Button> : <>
      <div><h3 className="font-semibold">Use a new document for this run</h3><p className="mt-1 text-xs text-gray-500">Upload → review fields → run. A new file clears earlier run inputs. No ERP record is changed by uploading.</p></div>
      <label className="block">Documents or images<input aria-label="Workflow input document" key={files.length ? "chosen" : "empty"} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.txt,.csv,.tsv,.json,.docx,.xlsx" disabled={disabled || busy} onChange={choose} className="mt-2 block w-full text-xs" /></label>
      <p className="text-xs text-gray-500">Up to six files, 16 MiB total. Multiple images must be pages or supporting documents for the same record. Separate customers or items need a batch workflow.</p>
      {files.map((file, index) => <p key={index} className="break-all text-xs">Selected: {file.name}{files.length > 1 ? ` · ${results[index] ? "read" : "pending"}` : ""}</p>)}
      <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={disabled || busy || !files.length || complete || !models?.configured} onClick={prepare}>{busy ? "Preparing document…" : files.length > 1 ? "Read documents" : "Read document"}</Button>{files.length > 0 && <Button variant="secondary" disabled={disabled || busy} onClick={clear}>Remove document</Button>}</div>
      {busy && files.length > 1 && <p role="status" className="text-xs">Reading file {readingIndex} of {files.length}. Every file must finish before inputs can be used.</p>}
      {busy && <p role="status" className="text-xs">Reading your document and preparing the fields. OCR continues in the background; please keep this review open.</p>}
      {models && !models.configured && <p role="status" className="text-xs text-amber-700">Automatic document reading is not configured. Ask an administrator, or remove the document and enter inputs manually.</p>}
      {complete && <div className="space-y-2">
        <p className="font-medium">Document read. Review the extracted values below.</p>
        {results.map((result, index) => <div key={index} className="space-y-1"><p className="text-xs font-semibold">{files[index].name}</p><details><summary className="cursor-pointer text-xs text-gray-500">Document reading notes</summary><p className="mt-2 text-xs leading-5 text-gray-500">{result.attachment.summary}</p></details>
          <p role="status" className="text-xs">{receipts[index]?.extraction_state === "SUCCEEDED" ? "OCR completed." : receipts[index]?.status === "EXTRACTING" ? "OCR is still processing. Review the provisional fields against the original." : "OCR completion is not confirmed."} {result.pipelineStorageConfirmed ? "Source uploaded privately; not indexed by this step." : "Pipeline storage is not confirmed; keep the original file."}</p>
          {!!result.attachment.warnings?.length && <details><summary className="cursor-pointer text-xs text-amber-700 dark:text-amber-300">Initial reading notes</summary><p className="mt-1 text-xs text-gray-500">Recorded during initial reading. The current OCR status is shown above.</p>{result.attachment.warnings.map((warning, at) => <p className="text-xs text-amber-700 dark:text-amber-300" key={at}>{documentNotice(warning, result.attachment.model || model)}</p>)}</details>}</div>)}
        {proposal.warnings.map((warning, index) => <p className="text-xs text-amber-700 dark:text-amber-300" key={index}>{warning}</p>)}
        {files.length > 1 && <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={sameRecord} disabled={disabled || busy} onChange={event => { setSameRecord(event.target.checked); onGate({ selected: true, ready: false }); onReset(); }} />These files all belong to the same record.</label>}
        <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={disabled || busy || proposal.blocked || files.length > 1 && !sameRecord} onClick={() => { onPrepared(proposal.values); onGate({ selected: true, ready: true }); }}>Use extracted values</Button>{results.some(result => result.attachment.uploadId) && <Button variant="secondary" disabled={disabled || busy} onClick={refresh}>Check OCR status</Button>}</div>
        <p className="text-xs text-gray-500">Only exact declared fields are copied. Review and correct the inputs below; missing mandatory fields still block Run.</p>
      </div>}
      {session && <a href={`/chat/${encodeURIComponent(session.id)}`} target="_blank" rel="noopener noreferrer" className="inline-block text-xs font-semibold text-primary underline">Open source conversation</a>}
      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-300">{documentNotice(error, model)} No workflow run was sent.</p>}
    </>}
  </section>;
}
