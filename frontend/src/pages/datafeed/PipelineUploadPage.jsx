import { useRef, useState } from "react";
import { Icon } from "@iconify/react";
import Card from "../../components/shared/ui/Card";
import Button from "../../components/shared/ui/Button";
import { pipelineService } from "../../services/pipeline.service";
import { useNotifications } from "../../context/NotificationContext";

const DOCUMENT_TYPES = ["", "payslip", "invoice", "contract", "other"];
const SENSITIVITY_LEVELS = ["", "public", "internal", "confidential", "restricted"];

/*******************************************************************************
 * Function: PipelineUploadPage
 *
 * Upload screen for the ERP data-transformation pipeline — CSV/TSV/TXT for
 * schema indexing, and PDF/image documents for OCR + semantic indexing.
 * Every request goes through this app's own same-origin proxy; the pipeline
 * API key is injected server-side and never reaches the browser.
 ******************************************************************************/
function PipelineUploadPage() {
  return (
    <div className="space-y-6">
      <section>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">Data pipeline</p>
        <h1 className="page-heading mt-3 text-gray-950 dark:text-white">Upload Documents</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">
          Send CSV data or PDF/image documents into the semantic retrieval pipeline. Uploads route through this
          app's own server-side proxy — the pipeline API key is never exposed to the browser.
        </p>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <CsvUploadCard />
        <DocumentUploadCard />
      </div>
    </div>
  );
}

/*******************************************************************************
 * Function: CsvUploadCard
 *
 * Handles CSV/TSV/TXT upload, then polls schema_index_job_id (when present)
 * until the schema-indexing job reaches a terminal state.
 ******************************************************************************/
function CsvUploadCard() {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | uploading | indexing | done | error
  const [result, setResult] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const { notify } = useNotifications();

  const reset = () => { setStatus("idle"); setResult(null); setJob(null); setError(null); };

  const handleUpload = async () => {
    if (!file) return;
    setStatus("uploading"); setResult(null); setJob(null); setError(null);
    try {
      const uploaded = await pipelineService.uploadCsv(file);
      setResult(uploaded);
      notify(`${file.name} uploaded — ${uploaded.columns ?? 0} columns detected`, "success");
      if (uploaded.schema_index_job_id) {
        setStatus("indexing");
        const finalJob = await pipelineService.waitForJob(uploaded.schema_index_job_id, { onTick: setJob });
        setJob(finalJob);
        setStatus("done");
      } else {
        setStatus("done");
      }
    } catch (err) {
      const apiError = err?.error ?? { message: "CSV upload failed" };
      setError(apiError);
      setStatus("error");
      notify(apiError.message || "CSV upload failed", "error");
    }
  };

  const busy = status === "uploading" || status === "indexing";

  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <Icon icon="mdi:file-delimited-outline" className="h-5 w-5 text-primary" />
        <h2 className="section-title">CSV / TSV / TXT</h2>
      </div>

      <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 px-4 py-8 text-center transition hover:border-primary dark:border-gray-700">
        <Icon icon="mdi:cloud-upload-outline" className="h-8 w-8 text-gray-400" />
        <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          {file ? file.name : "Choose a CSV, TSV, or TXT file"}
        </span>
        <span className="text-xs text-gray-400">Only the schema is indexed — not every row</span>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.tsv,.txt"
          className="hidden"
          disabled={busy}
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); reset(); }}
        />
      </label>

      <div className="mt-4 flex items-center gap-2">
        <Button onClick={handleUpload} disabled={!file || busy}>
          {busy ? <Icon icon="mdi:loading" className="h-4 w-4 animate-spin" /> : <Icon icon="mdi:upload" className="h-4 w-4" />}
          {status === "uploading" ? "Uploading…" : status === "indexing" ? "Indexing…" : "Upload"}
        </Button>
        {result && (
          <Button variant="secondary" onClick={() => { setFile(null); reset(); if (inputRef.current) inputRef.current.value = ""; }}>
            Clear
          </Button>
        )}
      </div>

      {error && <ApiErrorNotice error={error} className="mt-4" />}

      {result && (
        <div className="mt-4 space-y-3 rounded-xl border border-gray-100 p-4 dark:border-gray-800">
          <SummaryRow label="Upload ID" value={result.upload_id} mono />
          <SummaryRow label="Columns" value={result.columns} />
          <SummaryRow label="Rows sampled" value={`${result.rows_sampled}${result.sample_limited ? " (sample limited)" : ""}`} />
          <SummaryRow label="Published" value={result.published ? "Yes" : "No"} tone={result.published ? "good" : "warn"} />
          <SummaryRow label="Schema ID" value={result.schema_id ?? "—"} mono />
          {result.warnings?.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-300">
              {result.warnings.join(" · ")}
            </div>
          )}
          <JobStatusRow job={job} pending={status === "indexing"} />
        </div>
      )}
    </Card>
  );
}

/*******************************************************************************
 * Function: DocumentUploadCard
 *
 * Handles PDF/image upload with optional identity metadata, then polls
 * index_job_id (when present) until the document-indexing job finishes.
 ******************************************************************************/
function DocumentUploadCard() {
  const [file, setFile] = useState(null);
  const [metadata, setMetadata] = useState({
    source_system_id: "", source_entity: "", parent_record_id: "",
    business_key_name: "", business_key_value: "", document_type: "", sensitivity: "",
  });
  const [status, setStatus] = useState("idle");
  const [result, setResult] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const { notify } = useNotifications();

  const setField = (name) => (e) => setMetadata((m) => ({ ...m, [name]: e.target.value }));

  const reset = () => { setStatus("idle"); setResult(null); setJob(null); setError(null); };

  const handleUpload = async () => {
    if (!file) return;
    // business_key_name and business_key_value must travel together, or the API returns 422.
    if (Boolean(metadata.business_key_name) !== Boolean(metadata.business_key_value)) {
      notify("Business key name and value must both be set, or both left blank", "error");
      return;
    }
    setStatus("uploading"); setResult(null); setJob(null); setError(null);
    try {
      const uploaded = await pipelineService.uploadDocument(file, metadata);
      setResult(uploaded);
      notify(`${file.name} uploaded — ${uploaded.page_count ?? 0} page(s), ${uploaded.extraction_status}`, "success");
      if (uploaded.index_job_id) {
        setStatus("indexing");
        const finalJob = await pipelineService.waitForJob(uploaded.index_job_id, { onTick: setJob });
        setJob(finalJob);
        setStatus("done");
      } else {
        setStatus("done");
      }
    } catch (err) {
      const apiError = err?.error ?? { message: "Document upload failed" };
      setError(apiError);
      setStatus("error");
      notify(apiError.message || "Document upload failed", "error");
    }
  };

  const busy = status === "uploading" || status === "indexing";

  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <Icon icon="mdi:file-pdf-box" className="h-5 w-5 text-primary" />
        <h2 className="section-title">PDF / Image</h2>
      </div>

      <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 px-4 py-8 text-center transition hover:border-primary dark:border-gray-700">
        <Icon icon="mdi:cloud-upload-outline" className="h-8 w-8 text-gray-400" />
        <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          {file ? file.name : "Choose a PDF, PNG, JPG, TIFF, or BMP file"}
        </span>
        <span className="text-xs text-gray-400">Scanned pages use OCR automatically</span>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp"
          className="hidden"
          disabled={busy}
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); reset(); }}
        />
      </label>

      <details className="mt-3 rounded-xl border border-gray-100 dark:border-gray-800">
        <summary className="cursor-pointer px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-gray-500">
          Optional document identity
        </summary>
        <div className="grid gap-3 px-4 pb-4 md:grid-cols-2">
          <TextField label="Source system ID" value={metadata.source_system_id} onChange={setField("source_system_id")} disabled={busy} />
          <TextField label="Source entity" value={metadata.source_entity} onChange={setField("source_entity")} placeholder="e.g. employee, invoice" disabled={busy} />
          <TextField label="Parent record ID" value={metadata.parent_record_id} onChange={setField("parent_record_id")} disabled={busy} />
          <SelectField label="Document type" value={metadata.document_type} onChange={setField("document_type")} options={DOCUMENT_TYPES} disabled={busy} />
          <TextField label="Business key name" value={metadata.business_key_name} onChange={setField("business_key_name")} placeholder="e.g. employee_number" disabled={busy} />
          <TextField label="Business key value" value={metadata.business_key_value} onChange={setField("business_key_value")} placeholder="e.g. EMP-10042" disabled={busy} />
          <SelectField label="Sensitivity" value={metadata.sensitivity} onChange={setField("sensitivity")} options={SENSITIVITY_LEVELS} disabled={busy} />
        </div>
      </details>

      <div className="mt-4 flex items-center gap-2">
        <Button onClick={handleUpload} disabled={!file || busy}>
          {busy ? <Icon icon="mdi:loading" className="h-4 w-4 animate-spin" /> : <Icon icon="mdi:upload" className="h-4 w-4" />}
          {status === "uploading" ? "Uploading…" : status === "indexing" ? "Indexing…" : "Upload"}
        </Button>
        {result && (
          <Button variant="secondary" onClick={() => { setFile(null); reset(); if (inputRef.current) inputRef.current.value = ""; }}>
            Clear
          </Button>
        )}
      </div>

      {error && <ApiErrorNotice error={error} className="mt-4" />}

      {result && (
        <div className="mt-4 space-y-3 rounded-xl border border-gray-100 p-4 dark:border-gray-800">
          <SummaryRow label="Upload ID" value={result.upload_id} mono />
          <SummaryRow label="File type" value={result.file_type} />
          <SummaryRow label="Pages" value={result.page_count} />
          <SummaryRow label="Extraction" value={result.extraction_status} />
          <SummaryRow label="OCR used" value={result.ocr_used ? "Yes" : "No"} />
          {result.warnings?.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-300">
              {result.warnings.join(" · ")}
            </div>
          )}
          <JobStatusRow job={job} pending={status === "indexing"} errorText={result.indexing_error} />
        </div>
      )}
    </Card>
  );
}

/*******************************************************************************
 * Function: JobStatusRow
 *
 * Shows the live status of a schema/document indexing job while it's being
 * polled, and its final terminal state once done.
 ******************************************************************************/
function JobStatusRow({ job, pending, errorText }) {
  if (!job && !pending && !errorText) return null;
  const status = job?.status ?? (pending ? "pending" : null);
  const tone = status === "succeeded" ? "good" : status === "failed" || status === "interrupted" ? "bad" : "warn";
  return (
    <div className="flex items-center justify-between border-t border-gray-100 pt-3 dark:border-gray-800">
      <span className="text-xs font-bold uppercase tracking-wide text-gray-500">Indexing job</span>
      <span className={`flex items-center gap-1.5 text-sm font-semibold ${
        tone === "good" ? "text-emerald-600" : tone === "bad" ? "text-red-600" : "text-amber-600"
      }`}>
        {pending && <Icon icon="mdi:loading" className="h-3.5 w-3.5 animate-spin" />}
        {status ?? "not started"}
      </span>
      {errorText && <p className="mt-1 text-xs text-red-600">{errorText}</p>}
    </div>
  );
}

/*******************************************************************************
 * Function: ApiErrorNotice
 *
 * Renders the pipeline API's error envelope — message plus a request_id for
 * support/log correlation.
 ******************************************************************************/
function ApiErrorNotice({ error, className = "" }) {
  return (
    <div className={`flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/40 dark:bg-red-900/20 dark:text-red-400 ${className}`}>
      <Icon icon="mdi:alert-circle" className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <p className="font-semibold">{error.message || "Upload failed"}</p>
        {error.code && <p className="mt-0.5 text-xs opacity-80">{error.code}</p>}
        {error.request_id && <p className="mt-0.5 font-mono text-[10px] opacity-70">request_id: {error.request_id}</p>}
      </div>
    </div>
  );
}

/*******************************************************************************
 * Function: SummaryRow
 *
 * Performs the Summary Row operation for the PipelineUploadPage module.
 ******************************************************************************/
function SummaryRow({ label, value, mono = false, tone = null }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-bold uppercase tracking-wide text-gray-500">{label}</span>
      <span className={`max-w-[60%] truncate text-right text-sm font-semibold ${mono ? "font-mono" : ""} ${
        tone === "good" ? "text-emerald-600" : tone === "warn" ? "text-amber-600" : "text-gray-950 dark:text-white"
      }`}>
        {value ?? "—"}
      </span>
    </div>
  );
}

/*******************************************************************************
 * Function: TextField
 *
 * Performs the Text Field operation for the PipelineUploadPage module.
 ******************************************************************************/
function TextField({ label, value, onChange, placeholder, disabled }) {
  return (
    <label className="block text-xs">
      <span className="font-bold uppercase tracking-wide text-gray-500">{label}</span>
      <input
        type="text"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-primary disabled:opacity-50 dark:border-gray-700 dark:bg-darkBackground dark:text-white"
      />
    </label>
  );
}

/*******************************************************************************
 * Function: SelectField
 *
 * Performs the Select Field operation for the PipelineUploadPage module.
 ******************************************************************************/
function SelectField({ label, value, onChange, options, disabled }) {
  return (
    <label className="block text-xs">
      <span className="font-bold uppercase tracking-wide text-gray-500">{label}</span>
      <select
        value={value}
        onChange={onChange}
        disabled={disabled}
        className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-primary disabled:opacity-50 dark:border-gray-700 dark:bg-darkBackground dark:text-white"
      >
        {options.map((opt) => <option key={opt} value={opt}>{opt || "—"}</option>)}
      </select>
    </label>
  );
}

export default PipelineUploadPage;
