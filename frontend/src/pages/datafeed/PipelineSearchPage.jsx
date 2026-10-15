import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Button from "../../components/shared/ui/Button";
import { documentWorkspaceService as service } from "../../services/document-workspace.service";
import { useAuthContext } from "../../context/AuthContext";
import { authorityScope } from "../../utils/authAuthority";

export default function PipelineSearchPage() {
  const { user } = useAuthContext();
  return <DocumentSearch key={authorityScope(user)} />;
}

function DocumentSearch() {
  const [query, setQuery] = useState(""), [result, setResult] = useState(null), [document, setDocument] = useState(null);
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const active = useRef(true), pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const run = async (label, operation) => {
    if (pending.current) return;
    pending.current = true; setBusy(label); setError("");
    try { await operation(); } catch (cause) { if (active.current) setError(cause.message || "Document retrieval was not confirmed."); }
    finally { pending.current = false; if (active.current) setBusy(""); }
  };
  const search = event => {
    event.preventDefault(); if (!query.trim()) return;
    setDocument(null); setResult(null);
    void run("Searching documents…", async () => { const value = await service.search(query.trim()); if (active.current) setResult(value); });
  };
  return <div className="space-y-6">
    <header className="border-b border-gray-200 pb-5 dark:border-gray-800"><p className="text-xs font-semibold uppercase tracking-widest text-primary">Data pipeline</p><h1 className="page-heading mt-2">Document search</h1><p className="mt-2 text-sm text-gray-500">Search your permitted indexed files, then open a match to read its reviewed details. This is separate from RAG policy checks.</p></header>
    <form aria-label="Search indexed documents" onSubmit={search} className="flex max-w-3xl flex-wrap items-end gap-3">
      <label className="min-w-64 flex-1 text-sm font-medium">Name, reference or document details<input value={query} maxLength={2000} disabled={Boolean(busy)} onChange={event => setQuery(event.target.value)} placeholder="Customer name or registration reference" className="mt-2 w-full rounded-xl border border-gray-300 bg-transparent px-3 py-3 dark:border-gray-700" /></label>
      <Button type="submit" disabled={!query.trim() || Boolean(busy)}>{busy === "Searching documents…" ? busy : "Search documents"}</Button>
    </form>
    <p className="text-xs text-gray-500">Up to 10 current document matches. Results are not a complete inventory count. No model or ERP operation is needed for this search.</p>
    {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
    <div className="grid gap-7 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
      <section aria-label="Document matches"><h2 className="text-lg font-semibold">Matches</h2>
        {result ? <><p role="status" className="mt-2 text-xs text-gray-500">{result.items?.length ?? 0} matches · {result.collections_searched ?? 0} permitted collections searched</p>{!result.items?.length && <p className="mt-5 text-sm text-gray-500">No permitted current document matched. Check the reference and confirm the upload is searchable.</p>}
          <ul className="mt-3 divide-y divide-gray-200 dark:divide-gray-800">{result.items?.map(item => <li key={item.document_id} className="py-4"><p className="text-sm font-medium">{item.source_system_id} / {item.source_entity}</p><p className="my-2 text-xs text-gray-500">{item.document_type?.replaceAll("_", " ")} · version {item.version}</p><Button variant="secondary" disabled={Boolean(busy)} onClick={() => { setDocument(null); void run("Opening document…", async () => { const value = await service.resolve(item.document_id); if (active.current) setDocument(value); }); }}>Open document</Button></li>)}</ul></> : <p className="mt-3 text-sm text-gray-500">{busy || "Enter a name or reference to search stored documents."}</p>}
      </section>
      <section aria-label="Retrieved document" aria-live="polite" className="min-w-0 border-l border-gray-200 pl-6 dark:border-gray-800"><h2 className="text-lg font-semibold">Document details</h2>{document ? <div className="mt-4 space-y-4"><div><h3 className="font-medium">{document.filename}</h3><p className="mt-1 text-xs text-gray-500">{document.source_system_id} / {document.source_entity} · version {document.version}</p></div><dl className="divide-y divide-gray-100 text-sm dark:divide-gray-800">{Object.entries(document.form_fields ?? {}).map(([name, value]) => <div key={name} className="grid grid-cols-2 gap-3 py-2"><dt className="text-gray-500">{name.replaceAll("_", " ")}</dt><dd className="break-words">{typeof value === "object" ? JSON.stringify(value) : String(value ?? "")}</dd></div>)}</dl><details><summary className="cursor-pointer text-sm text-primary">Stored document text</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{document.text}</pre></details><p className="text-xs text-gray-500">Retrieved from the pipeline’s current saved version. This is not an ERP creation or policy-approval receipt.</p></div> : <p className="mt-3 text-sm text-gray-500">{busy === "Opening document…" ? busy : "Open a match to fetch its fields and stored text."}</p>}</section>
    </div>
    <nav className="flex gap-5 border-t border-gray-200 pt-5 text-sm text-primary dark:border-gray-800"><Link to="/datafeed/upload">Files &amp; Documents</Link><Link to="/datafeed/chat">Ask about documents in chat</Link></nav>
  </div>;
}
