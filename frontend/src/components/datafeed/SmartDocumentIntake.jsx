import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Button from "../shared/ui/Button";
import ChatAttachmentReview from "../chat/ChatAttachmentReview";
import { chatService } from "../../services/chat.service";
import { documentWorkspaceService as documents } from "../../services/document-workspace.service";
import { documentNotice } from "../../utils/documentPresentation";

const instructionDefault = "Read this business document, choose its matching registered record type and prepare its fields for review. Do not invent missing values or create an ERP record.";
const extensions = /\.(pdf|png|jpe?g|tiff?|txt|csv|tsv|json|docx|xlsx)$/i;

/** Same governed intake as chat: choose a file, infer a registered schema,
 * review source values, then explicitly confirm pipeline-only indexing. */
export default function SmartDocumentIntake() {
  const [file, setFile] = useState(null), [instruction, setInstruction] = useState("");
  const [catalog, setCatalog] = useState(null), [models, setModels] = useState(null), [model, setModel] = useState("");
  const [schemaId, setSchemaId] = useState(""), [session, setSession] = useState(null), [prepared, setPrepared] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  const active = useRef(true), pending = useRef(false), requestKey = useRef(null), sessionKey = useRef(crypto.randomUUID());
  useEffect(() => {
    active.current = true;
    Promise.all([chatService.models(), documents.catalog()]).then(([modelCatalog, schemaCatalog]) => {
      if (!active.current) return;
      setModels(modelCatalog); setModel(modelCatalog.binding?.model || ""); setCatalog(schemaCatalog);
    }).catch(() => { if (active.current) setError("Could not load document preparation. Refresh this page or use chat to attach the file."); })
      .finally(() => { if (active.current) setLoading(false); });
    return () => { active.current = false; };
  }, []);
  const choose = event => {
    const chosen = event.target.files?.[0];
    setError(""); setPrepared(null);
    if (!chosen || !chosen.size || chosen.size > 16 * 1024 * 1024 || !extensions.test(chosen.name)) {
      setFile(null); setError("Choose a supported, non-empty business document up to 16 MiB."); return;
    }
    setFile(chosen); requestKey.current = crypto.randomUUID();
  };
  const prepare = async event => {
    event.preventDefault();
    if (pending.current || !file || !models?.configured) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const conversation = session || await chatService.createSession(`Document: ${file.name}`.slice(0, 100), { idempotencyKey: sessionKey.current });
      if (!active.current) return;
      setSession(conversation);
      const result = await documents.prepare(conversation.id, file, { idempotencyKey: requestKey.current, instruction: instruction.trim() || instructionDefault, model, schemaId, saveToConversation: true });
      if (active.current) setPrepared({ attachment: { ...result.attachment, sessionId: conversation.id }, upload: result.upload });
    } catch (cause) {
      if (active.current) setError(cause.message || "Preparation was not confirmed. Keep this page and the same file; check the linked conversation before retrying.");
    } finally { pending.current = false; if (active.current) setBusy(false); }
  };
  return <section aria-label="Automatic document preparation" className="space-y-5 border-y border-gray-200 py-6 dark:border-gray-800">
    <div><h2 className="text-xl font-semibold">Upload a business document</h2><p className="mt-2 max-w-3xl text-sm text-gray-500">The assistant detects the record type and fills details from your file. Review the result before saving. Missing or uncertain values are never invented.</p></div>
    <form onSubmit={prepare} className="space-y-4">
      <label className="block rounded-xl border border-dashed border-gray-300 p-5 text-sm transition-colors focus-within:border-primary hover:border-primary dark:border-gray-700">
        <span className="block font-medium">Choose a document or image</span><span className="mt-1 block text-xs text-gray-500">PDF, images, spreadsheets and supported text documents · up to 16 MiB</span>
        <input aria-label="Choose a business document" type="file" accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.txt,.csv,.tsv,.json,.docx,.xlsx" disabled={busy || loading} onChange={choose} className="mt-3 block max-w-full text-sm" />
      </label>
      <label className="block text-sm font-medium">What would you like to do? <span className="font-normal text-gray-500">(optional)</span><textarea aria-label="Document request" rows={2} maxLength={2000} disabled={busy} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="Read this customer registration form." className="mt-2 w-full rounded-lg border border-gray-300 bg-transparent p-3 font-normal dark:border-gray-700" /></label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy || loading || !file || !models?.configured}>{busy ? "Reading and sorting document…" : "Read document"}</Button>
        {loading && <p role="status" className="text-sm text-gray-500">Loading document preparation…</p>}
        {session && <Link className="text-sm text-primary hover:underline" to={`/chat/${session.id}`}>Continue in chat</Link>}
      </div>
      <details className="text-sm"><summary className="cursor-pointer text-gray-500">Preparation options</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label>Record type<select aria-label="Preferred record type" disabled={busy} value={schemaId} onChange={event => setSchemaId(event.target.value)} className="mt-1 w-full rounded-lg border bg-transparent p-2"><option value="">Detect automatically</option>{catalog?.entities?.map(schema => <option key={schema.id} value={schema.id}>{schema.source_entity} · {schema.source_system_id}</option>)}</select></label>
      </div></details>
    </form>
    {busy && <p role="status" className="text-sm text-gray-500">Reading your document and preparing the review. OCR continues in the background. Completion time depends on the file.</p>}
    {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{documentNotice(error, model)}</p>}
    {!loading && models && !models.configured && <p role="status" className="text-sm text-amber-700">Automatic document reading is not configured. Ask an administrator to enable it.</p>}
    {prepared && <ChatAttachmentReview key={`${prepared.attachment.uploadId || prepared.attachment.sourceHash}:${prepared.upload?.revision ?? 0}`} attachment={prepared.attachment} initialUpload={prepared.upload} initialSchema={catalog?.entities?.find(schema => schema.id === prepared.upload?.proposal?.schemaId)} busy={busy} />}
    <p className="text-xs leading-5 text-gray-500">The registered schema determines the collection and record key. This step does not create an ERP record; request that separately in chat and confirm the exact proposed change.</p>
  </section>;
}
