import { useEffect, useRef, useState } from "react";
import Button from "../shared/ui/Button";
import { useAuthContext } from "../../context/AuthContext";
import { documentWorkspaceService as service } from "../../services/document-workspace.service";
import { authorityScope } from "../../utils/authAuthority";
import CollectionSummary from "./CollectionSummary";

const example = { source_system_id: "hr_system", source_entity: "applications", description: "Reviewed registration forms; importing a schema does not import ERP records.", primary_key: "application_id",
  fields: [{ name: "application_id", type: "string", generated: true }, { name: "name", type: "string", required: true }, { name: "email", type: "email" }],
  document_types: ["registration_form", "leave_note", "medical_certificate"], reader_roles: [], minimum_sensitivity: "confidential" };

export default function DocumentCatalog() {
  const { user } = useAuthContext();
  return <DocumentCatalogWorkspace key={authorityScope(user)} user={user} />;
}

function DocumentCatalogWorkspace({ user }) {
  const [schemas, setSchemas] = useState([]), [inventory, setInventory] = useState(null), [source, setSource] = useState(JSON.stringify(example, null, 2));
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [catalog, setCatalog] = useState(null), [migrationId, setMigrationId] = useState(""), [migrationReviewed, setMigrationReviewed] = useState(false);
  const active = useRef(true), pending = useRef(false);
  useEffect(() => { active.current = true; Promise.all([service.catalog(), service.inventory()]).then(([catalog, summary]) => {
    if (active.current) { setSchemas(catalog.entities ?? []); setCatalog(catalog); setInventory(summary); }
  }).catch(cause => { if (active.current) setError(cause.message); }); return () => { active.current = false; }; }, []);
  const run = async operation => {
    if (pending.current) return; pending.current = true; setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (cause) { if (active.current) setError(cause.message); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  };
  const refresh = async () => {
    const [catalog, summary] = await Promise.all([service.catalog(), service.inventory()]);
    if (active.current) { setSchemas(catalog.entities ?? []); setCatalog(catalog); setInventory(summary); setMigrationReviewed(false); }
  };
  return <section aria-label="Entity schemas and document inventory" className="surface-panel space-y-4 rounded-2xl p-5">
    <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Entity schemas &amp; private documents</h2><p className="mt-1 text-sm text-gray-500">Schemas describe possible records. Inventory counts only your uploads and permitted confirmed documents.</p></div><Button variant="secondary" disabled={busy} onClick={() => run(refresh)}>Refresh inventory</Button></div>
    {inventory && <p role="status" className="text-sm">{inventory.counts_complete ? "" : "Bounded sample — "}{inventory.searchable_documents} searchable · {inventory.pending_review} pending review · {inventory.index_failed} index failures · as of {new Date(inventory.as_of).toLocaleString()}</p>}
    <div className="divide-y divide-gray-200 dark:divide-gray-700">{schemas.map(schema => <div className="flex items-center justify-between gap-3 py-2 text-sm" key={schema.id}><div><p className="font-semibold">{schema.source_system_id} / {schema.source_entity}</p><p className="text-xs text-gray-500">{schema.fields.length} declared fields · revision {schema.revision} · {schema.lookup_tool ? `lookup: ${schema.lookup_tool}` : "pipeline forms only; no ERP lookup configured"}</p></div>{user?.permissions?.includes("registry:write") && <Button variant="ghost" disabled={busy} onClick={() => { setSource(JSON.stringify({ source_system_id: schema.source_system_id, source_entity: schema.source_entity, description: schema.description, primary_key: schema.primary_key,
      fields: schema.fields, document_types: schema.document_types, reader_roles: schema.reader_roles, minimum_sensitivity: schema.minimum_sensitivity, ...(schema.lookup_tool ? { lookup_tool: schema.lookup_tool } : {}), expected_revision: schema.revision }, null, 2)); setEditorOpen(true); }}>Edit schema</Button>}</div>)}</div>
    {!schemas.length && <p className="text-sm">No imported entity schemas are available.</p>}
    <CollectionSummary catalog={catalog} />
    {user?.permissions?.includes("registry:write") && inventory?.legacy_current_documents > 0 && <details><summary className="cursor-pointer text-sm font-semibold">Migrate an owned document to its schema collection</summary><div className="mt-3 space-y-3 text-xs">
      <p>Reindex the current reviewed version, then switch its destination only after success. No files, records or old vectors are deleted. Other owners must migrate their own documents.</p>
      <label className="block">Current legacy document<select aria-label="Legacy document to migrate" className="mt-1 w-full rounded-lg border bg-transparent p-2" disabled={busy} value={migrationId} onChange={event => { setMigrationId(event.target.value); setMigrationReviewed(false); }}><option value="">Choose your document</option>{(inventory.documents ?? []).filter(doc => doc.owner_id === user.id && doc.current_upload_id && !doc.vector_collection && !doc.pending_upload_id).map(doc => <option key={doc.id} value={doc.id}>{doc.source_system_id} / {doc.source_entity} · {doc.document_type} · v{doc.version} · {doc.id}</option>)}</select></label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={migrationReviewed} disabled={busy || !migrationId} onChange={event => setMigrationReviewed(event.target.checked)} />I reviewed this collection move. Keep old vectors and the same document version.</label>
      <Button variant="secondary" disabled={busy || !migrationId || !migrationReviewed} onClick={() => run(async () => { const doc = inventory.documents.find(item => item.id === migrationId); if (!doc) throw new Error("Refresh the document inventory first."); const receipt = await service.migrate({ document_id: doc.id, expected_revision: doc.revision, review_confirmed: true }); if (active.current) { setNotice(`Collection move ${receipt.status === "MIGRATED" ? "confirmed" : "already complete"}. Document version unchanged; no old vectors deleted.`); setMigrationId(""); } await refresh(); })}>Reindex &amp; move collection</Button>
    </div></details>}
    {user?.permissions?.includes("registry:write") && <details open={editorOpen} onToggle={event => setEditorOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm font-semibold">Import or update an entity schema</summary><div className="mt-3 space-y-3">
      <p className="text-xs text-gray-500">Use explicit field names, types, primary key and document types. Optional lookup_tool must name a reviewed read-only ERPBridge tool. Revisions prevent overwriting a newer schema.</p>
      <label className="block text-xs">Load schema JSON<input aria-label="Load entity schema JSON" type="file" accept=".json,application/json" className="mt-1 block" disabled={busy} onChange={event => run(async () => {
        const file = event.target.files?.[0]; if (!file) return; if (file.size > 64000) throw new Error("Schema JSON must be at most 64 KB.");
        const value = JSON.parse(await file.text()); if (active.current) setSource(JSON.stringify(value, null, 2));
      })} /></label>
      <label className="block text-xs">Schema JSON<textarea aria-label="Entity schema JSON" value={source} disabled={busy} maxLength={64000} rows={12} spellCheck={false} className="mt-1 w-full rounded-lg border border-gray-300 bg-transparent p-3 font-mono text-xs dark:border-gray-600" onChange={event => setSource(event.target.value)} /></label>
      <Button disabled={busy} onClick={() => run(async () => { const schema = JSON.parse(source); await service.importSchema(schema); if (active.current) setNotice("Entity schema saved. No original ERP records were created or imported."); await refresh(); })}>Save entity schema</Button>
    </div></details>}
    <p className="text-xs text-gray-500">Open a chat → Documents &amp; forms to upload, review, and index a private attachment. Uploading a policy file does not activate it as a RAG policy.</p>
    {notice && <p role="status" className="text-sm text-primary">{notice}</p>}{error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
  </section>;
}
