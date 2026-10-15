import { useQuery } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { capabilityService } from "../../services/capability.service";
import { apiErrorMessage } from "../../services/api";
import { usePermissions } from "../../hooks/usePermissions";
import Button from "../shared/ui/Button";
import { reviewDataClasses, reviewPolicyMatches, sensitivityOptions, supportedReviewPolicy } from "./capabilityReviewPolicy";
import Fields, { fullyVisible } from "./CapabilityFields";
import DiscoveredCapabilityReview from "./DiscoveredCapabilityReview";
import { importReceiptMatches, supportedImportDecision } from "./discoveredReviewPolicy";

const words = (value) => String(value ?? "Not recorded").replaceAll("_", " ").toLowerCase();
const label = (value) => words(value).replace(/^./, (letter) => letter.toUpperCase());
const storageKey = (actorId, connectionId) => `workflow.capability-decision.${encodeURIComponent(actorId)}.${encodeURIComponent(connectionId)}`;
function restoreDecision(actorId, connectionId) {
  try {
    const text = sessionStorage.getItem(storageKey(actorId, connectionId));
    if (!text) return null;
    if (text.length > 8192) throw new Error();
    const value = JSON.parse(text);
    if (!["review", "disable", "import"].includes(value.action) || value.connectionId !== connectionId || typeof value.capabilityId !== "string" ||
        !value.capabilityId || value.capabilityId.length > 256 || !value.body || typeof value.body.note !== "string" ||
        !value.body.note.trim() || value.body.note.length > 2000) throw new Error();
    if (value.action === "review" && (typeof value.body.observationId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.body.contractHash) ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(value.body.decisionKey) || !supportedReviewPolicy(value.body))) throw new Error();
    if (value.action === "disable" && (typeof value.body.revisionId !== "string" || !Number.isSafeInteger(value.body.baseVersion) || value.body.baseVersion < 1)) throw new Error();
    if (value.action === "import" && !supportedImportDecision(value.body)) throw new Error();
    return value;
  } catch { return { invalid: true }; }
}

export default function CapabilityReviewPanel() {
  const { actorId, role, has } = usePermissions();
  if (!has("registry:read")) return null;
  return <ReviewWorkspace key={actorId} actorId={actorId} canReview={Boolean(actorId && role === "Platform Admin" && has("registry:write"))} />;
}

function ReviewWorkspace({ actorId, canReview }) {
  const [offset, setOffset] = useState(0);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [pendingByConnection, setPendingByConnection] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [inventory, setInventory] = useState([]);
  const [selectedRemote, setSelectedRemote] = useState(null);
  const lock = useRef(false);
  const query = useQuery({ queryKey: ["capability-review", actorId, selectedConnectionId, offset], queryFn: () => capabilityService.catalog(offset, selectedConnectionId), retry: false });
  const connectionId = query.data?.connection.id ?? selectedConnectionId;
  const pending = connectionId ? Object.hasOwn(pendingByConnection, connectionId) ? pendingByConnection[connectionId] : restoreDecision(actorId, connectionId) : null;
  const setPending = value => connectionId && setPendingByConnection(current => ({ ...current, [connectionId]: value }));
  const entries = query.data?.capabilities ?? [];
  const selected = entries.find((entry) => entry.capabilityId === selectedId) ?? null;
  const ready = !query.isFetching && !query.error && Boolean(query.data);
  const mutationAllowed = canReview && ready && query.data.persistence !== "unsupported-for-admission";

  async function run(action, task) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try { await task(); }
    catch (failure) { setError(apiErrorMessage(failure, `${action} could not be confirmed. Reload status before deciding what to do next.`)); }
    finally { lock.current = false; setBusy(false); }
  }
  async function sendDecision(decision) {
    const result = await capabilityService[decision.action](decision.capabilityId, decision.body, decision.connectionId);
    const admission = decision.action === "review" || decision.action === "import" ? result?.admission : result;
    if ((decision.action !== "import" && admission?.capabilityId !== decision.capabilityId) || !["AVAILABLE", "DISABLED", "BLOCKED"].includes(admission?.state) || !Number.isSafeInteger(admission?.version) ||
        (decision.action === "import" && (!importReceiptMatches(decision, result) || !reviewPolicyMatches(decision.body, result?.revision?.policy))) ||
        (decision.action === "review" && (result?.revision?.capabilityId !== decision.capabilityId || result?.revision?.connectionId !== decision.connectionId || result?.revision?.observationId !== decision.body.observationId || result?.revision?.contractHash !== decision.body.contractHash || !reviewPolicyMatches(decision.body, result?.revision?.policy))) ||
        (decision.action === "disable" && (admission?.state !== "DISABLED" || admission?.revisionId !== decision.body.revisionId))) {
      throw new Error("Decision acknowledgement is invalid");
    }
    // Keep the exact request until a receipt is confirmed. Retries of a saved
    // review cannot re-enable a capability that has subsequently been disabled.
    sessionStorage.removeItem(storageKey(actorId, decision.connectionId)); setPending(null);
    if (decision.action === "import") { setInventory(current => current.filter(item => item.remoteName !== decision.body.remoteName)); setSelectedRemote(null); setSelectedId(admission.capabilityId); setOffset(0); }
    setMessage(decision.action === "import" ? "Discovered-tool review acknowledged. Reloaded authority, not this receipt, determines whether the agent may use it." : decision.action === "review" ? "Review decision acknowledged. Current authority is shown in the reloaded catalog, not inferred from this receipt." : "Disable acknowledged. New dispatch is blocked; already-sent remote work is not rolled back.");
    await query.refetch();
  }
  function decide(action, entry, note, dataClass) {
    if (!mutationAllowed || pending || busy) return;
    run("Decision", async () => {
      if (action === "review" && !entry.reviewEligible) throw new Error("Review unavailable");
      const decision = { action, capabilityId: entry.capabilityId, connectionId, body: action === "review" ? {
        observationId: entry.observation.id, contractHash: entry.observation.contractHash,
        decisionKey: `review_${crypto.randomUUID()}`, effectClass: entry.observation.definition.is_read_only ? "read" : entry.observation.definition.operation_contract?.effect_class,
        riskClass: entry.observation.definition.is_read_only ? "low" : entry.observation.definition.risk_level.toLowerCase(), dataClass, retryPolicy: "never", note: note.trim(),
        ...(entry.observation.definition.is_read_only ? {} : { requireIndependentApproval: true }),
      } : { revisionId: entry.admission.revisionId, baseVersion: entry.admission.version, note: note.trim() } };
      if (action === "review" && !supportedReviewPolicy(decision.body)) throw new Error("Choose a supported reviewed data sensitivity before saving");
      // No credentials, arguments or results are stored. If local persistence
      // fails, don't submit a request whose decision identity could be lost.
      sessionStorage.setItem(storageKey(actorId, connectionId), JSON.stringify(decision)); setPending(decision);
      await sendDecision(decision);
    });
  }
  function importTool(item, policy) {
    if (!mutationAllowed || pending || busy) return;
    run("Import review", async () => {
      const decision = { action: "import", capabilityId: item.remoteName, connectionId, body: {
        ...policy, remoteName: item.remoteName, remoteHash: item.remoteHash, decisionKey: `import_${crypto.randomUUID()}` } };
      if (!supportedImportDecision(decision.body)) throw new Error("The discovered contract needs a complete explicit review");
      sessionStorage.setItem(storageKey(actorId, connectionId), JSON.stringify(decision)); setPending(decision);
      await sendDecision(decision);
    });
  }
  return <section aria-label="ERP capability review" className="border-t border-gray-200 pt-6 dark:border-gray-800">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="section-title">ERP capability review</h2><p className="mt-2 max-w-3xl text-sm text-gray-500">Discovery records evidence. An administrator reviews capability contracts; each operation still needs independent exact approval.</p></div>
      <div className="flex gap-2"><Button variant="secondary" disabled={busy} onClick={() => query.refetch()}>Reload review status</Button>
        {canReview ? <Button disabled={!ready || busy || Boolean(pending) || !query.data?.connection.discoveryAvailable} onClick={() => run("Discovery", async () => {
          const result = await capabilityService.discover(connectionId);
          if (result?.connectionId !== connectionId || result?.authorityGranted !== false || !Array.isArray(result?.unreviewedInventory)) throw new Error("Unsupported discovery response");
          setInventory(result.unreviewedInventory); setSelectedRemote(null); setOffset(0); setSelectedId(null);
          setMessage(`Discovery saved; no tool enabled. ${result.blockedCount ?? 0} existing admissions blocked by drift.`);
          await query.refetch();
        })}>{busy ? "Working…" : "Refresh discovery"}</Button> : null}
      </div>
    </div>
    {query.data?.connections.length > 1 ? <label className="mt-4 block max-w-md text-sm font-medium">Reviewed ERP connection<select aria-label="Capability review connection" value={connectionId} disabled={busy || Boolean(pending)} onChange={event => { setSelectedConnectionId(event.target.value); setOffset(0); setSelectedId(null); setInventory([]); setError(""); setMessage(""); }} className="mt-2 w-full rounded-md border border-gray-300 bg-transparent px-3 py-2 dark:border-gray-700">{query.data.connections.map(item => <option key={item.id} value={item.id}>{item.id}{item.primary ? " · primary" : ""}</option>)}</select></label> : null}
    {!canReview ? <p className="mt-3 text-sm text-gray-500">Read only. Current Platform Admin registry permission is required for decisions.</p> : null}
    {query.isLoading ? <p className="mt-4" role="status">Loading capability review…</p> : null}
    {query.error ? <p className="mt-4 text-sm text-red-700" role="alert">Review status unavailable. No new decisions can be submitted.</p> : null}
    {query.data ? <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 border-y border-gray-200 py-3 text-sm dark:border-gray-800">
      <p>Connection: <strong>{query.data.connection.id}</strong></p><p>Session: <strong>{label(query.data.connection.state)}</strong></p><p>Storage: <strong>{label(query.data.persistence)}</strong></p>
      <p className="w-full text-xs text-gray-500">Initialization is not proof of ERP authorization, delivery, or live tool readiness. {query.data.persistence === "memory-only" ? "Reviews in this mode do not survive a server restart." : "Distributed revocation is not qualified."}</p>
    </div> : null}
    {pending ? <div className="mt-4 border-l-2 border-amber-500 pl-4 text-sm" role="status">
      <p className="font-semibold">{pending.invalid ? "The local decision record needs recovery." : `Unconfirmed ${pending.action} decision`}</p>
      {!pending.invalid && pending.action === "review" ? <p className="mt-1">Requested data sensitivity: {label(pending.body.dataClass)}. Exact retries keep this choice.</p> : null}
      <p className="mt-1">No success is assumed. Keep the exact request for an acknowledgement retry, or reload authority before ending local retries.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {!pending.invalid && canReview ? <Button disabled={busy} onClick={() => run("Decision retry", () => sendDecision(pending))}>Retry exact decision</Button> : null}
        <Button variant="secondary" disabled={busy} onClick={() => run("Decision recovery", async () => {
          const result = await query.refetch(); if (result.error || !result.data) throw new Error("Status unavailable");
          sessionStorage.removeItem(storageKey(actorId, connectionId)); setPending(null);
          setMessage("Local retries ended after reloading status. This does not undo any saved decision; inspect current authority before submitting another review.");
        })}>Reload status and end local retries</Button>
      </div>
    </div> : null}
    {error ? <p role="alert" className="mt-4 text-sm text-red-700">{error}</p> : null}
    {message ? <p role="status" className="mt-4 text-sm text-gray-600 dark:text-gray-300">{message}</p> : null}
    <div className="mt-5 grid min-w-0 gap-6 lg:grid-cols-[minmax(14rem,0.7fr)_minmax(0,1.3fr)]">
      <div className="min-w-0"><h3 className="text-sm font-semibold">Current capability states</h3>
        {!entries.length && ready ? <p className="mt-3 text-sm text-gray-500">No capability observations. Configure a supported backend session, then refresh discovery.</p> : null}
        <ul className="mt-3 divide-y divide-gray-200 dark:divide-gray-800">{entries.map((entry) => {
          const definition = entry.observation?.definition ?? entry.revision?.definition;
          return <li key={entry.capabilityId}><button disabled={busy || Boolean(pending)} aria-pressed={selectedId === entry.capabilityId} onClick={() => setSelectedId(entry.capabilityId)} className="w-full rounded-lg px-2 py-3 text-left transition-colors hover:bg-gray-100 focus-visible:outline focus-visible:outline-primary dark:hover:bg-gray-800">
            <span className="block break-words text-sm font-semibold">{definition?.display_name || definition?.name || entry.capabilityId}</span><span className="mt-1 block break-all text-xs text-gray-500">{label(entry.effectiveState)} · {entry.observation?.toolId ?? entry.revision?.toolId}</span>
          </button></li>;
        })}</ul>
        <div className="mt-4 flex items-center gap-3"><Button variant="ghost" disabled={!offset || busy || Boolean(pending)} onClick={() => { setOffset(offset - 10); setSelectedId(null); }}>Previous</Button><span className="text-xs">Page {offset / 10 + 1}</span><Button variant="ghost" disabled={!ready || !query.data?.hasMoreCapabilities || busy || Boolean(pending)} onClick={() => { setOffset(offset + 10); setSelectedId(null); }}>Next</Button></div>
      </div>
      {selected ? <CapabilityInspector key={`${selected.capabilityId}:${selected.observation?.id}:${selected.admission?.version}`} entry={selected} canReview={mutationAllowed && !busy && !pending} onDecision={decide} /> : <p className="text-sm text-gray-500">Select a capability to inspect its inputs, output contract, roles, and current authority.</p>}
    </div>
    {inventory.length ? <details className="mt-6"><summary className="cursor-pointer text-sm font-semibold">Unmapped remote tools ({inventory.length})</summary><p className="my-2 text-sm text-gray-500">These tools have no local reviewed contract. They are not executable. Select a tool to inspect and review its policy.</p><ul className="divide-y divide-gray-200 text-sm dark:divide-gray-800">{inventory.map(item => <li key={item.remoteName} className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0"><p className="break-all">{item.definition?.display_name ?? item.remoteName} — {label(item.reason)}</p>
        <p className="mt-1 text-xs text-gray-500">{item.definition?.bridge_contract?.resource_version ? `Version ${item.definition.bridge_contract.resource_version}` : "Version not pinned"}{!item.importable ? " · Not eligible for import" : ""}</p>
        {item.definition?.display_name && item.remoteName !== item.definition.display_name ? <p className="mt-1 break-all text-xs text-gray-500">Selector: {item.remoteName}</p> : null}
      </div><Button variant="ghost" aria-label={`Inspect ${item.definition?.display_name ?? item.remoteName} · ${item.remoteName}`} disabled={busy || Boolean(pending)} onClick={() => setSelectedRemote(item.remoteName)}>Inspect</Button>
    </li>)}</ul></details> : null}
    {inventory.find(item => item.remoteName === selectedRemote) ? <DiscoveredCapabilityReview key={`${connectionId}:${selectedRemote}`} item={inventory.find(item => item.remoteName === selectedRemote)} roles={query.data?.roleOptions} canReview={mutationAllowed && !busy && !pending} onReview={importTool} /> : null}
  </section>;
}

function CapabilityInspector({ entry, canReview, onDecision }) {
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const definition = entry.observation?.definition ?? entry.revision?.definition;
  const operation = definition?.is_read_only === false;
  const dataClasses = reviewDataClasses(operation);
  const [dataClass, setDataClass] = useState(() => dataClasses.includes(entry.revision?.policy?.dataClass) ? entry.revision.policy.dataClass : "");
  const sensitivityHelp = useId();
  const validClass = dataClasses.includes(dataClass);
  const reportCoverage = definition?.report_coverage_contract?.profile === "report-coverage/v1" ? definition.report_coverage_contract : null;
  const projectedRelation = reportCoverage?.key_projection;
  const requestedRelation = reportCoverage?.requested_key_coverage;
  const readError = definition?.read_error_contract;
  const supportedReadError = !operation && readError?.profile === "erpbridge-read-error/v1" &&
    readError.remote_type === "not_found" && readError.business_error === "ERP_RESOURCE_NOT_FOUND";
  const complete = fullyVisible(definition);
  const validNote = note.trim().length > 0 && note.length <= 2000;
  return <div className="min-w-0">
    <h3 className="text-base font-semibold">Contract and authority</h3>
    <dl className="mt-3 space-y-2 break-words text-sm"><div><dt className="text-xs text-gray-500">Current state (not a dispatch guarantee)</dt><dd>{label(entry.effectiveState)}</dd></div>
      <div><dt className="text-xs text-gray-500">Review eligibility</dt><dd>{entry.reviewEligible ? operation ? "Supported operation contract; independent approval required for every invocation" : "Supported read; explicit review required" : label(entry.reviewReason)}</dd></div>
      <div><dt className="text-xs text-gray-500">Observation time</dt><dd>{entry.observation?.discoveredAt ?? "No observation"}</dd></div>
      <div><dt className="text-xs text-gray-500">Exact contract hash</dt><dd className="font-mono text-xs">{entry.observation?.contractHash ?? entry.revision?.contractHash}</dd></div>
      <div><dt className="text-xs text-gray-500">Output schema validation</dt><dd>{definition?.bridge_contract?.output_schema ? "Declared schema checked before downstream use" : "No declared output schema; bounded result handling still applies"}</dd></div>
      <div><dt className="text-xs text-gray-500">Business read-error mapping</dt><dd>{supportedReadError ? <>
        Proposed contract: an acknowledged ERP resource-not-found response is classified as a resource lookup failure only under this exact saved review.
        <span className="mt-1 block">This does not prove the record is absent, retry the read or authorize a handler. Permission denials, missing tool revisions, timeouts and uncertain writes are excluded. Adding this mapping requires a new review and explicit republication of affected workflows.</span>
      </> : readError ? "Unsupported mapping; it cannot authorize business-error handling." : "No mapping declared. Tool errors still stop the run; no business-error category is inferred from error text."}</dd></div>
      {reportCoverage ? <div><dt className="text-xs text-gray-500">Scheduled report coverage</dt><dd>Exact {reportCoverage.start_parameter} → {reportCoverage.end_parameter} interval; connector must attest complete result, no remaining page, returned items and matching count.
        <span className="mt-1 block">Business resource: <strong>{reportCoverage.business_resource ? label(reportCoverage.business_resource) : "Not declared — unavailable for automatic resource matching"}</strong>.</span>
        {projectedRelation ? <span className="mt-1 block">Related-record role: identifies the complete <strong>{projectedRelation.relation_name}</strong> key set from the primary records for a later reviewed report.</span> : null}
        {requestedRelation ? <span className="mt-1 block">Related-record role: accepts the reviewed <strong>{requestedRelation.relation_name}</strong> keys through <strong>{requestedRelation.keys_parameter}</strong> and must return each requested record exactly once.</span> : null}
        <span className="mt-1 block">This evidence does not approve a later effect.</span></dd></div> : null}
      {entry.revision ? <div><dt className="text-xs text-gray-500">Current saved review</dt><dd>{entry.revision.id} · {entry.revision.reviewedBy.id} · {entry.revision.reviewedAt}</dd></div> : null}
      {entry.revision ? <div><dt className="text-xs text-gray-500">Saved ERP output sensitivity</dt><dd>{label(entry.revision.policy?.dataClass)}</dd></div> : null}
      {entry.admission?.reason ? <div><dt className="text-xs text-gray-500">Stored block reason</dt><dd>{label(entry.admission.reason)}</dd></div> : null}
    </dl>
    {entry.revision ? <details className="mt-4"><summary className="cursor-pointer text-sm font-semibold">Saved review policy and previous contract</summary><div className="mt-3 max-h-[28rem] overflow-auto">{fullyVisible(entry.revision.definition) ? <Fields value={{ policy: entry.revision.policy, definition: entry.revision.definition }} /> : <p>Saved definition exceeds the inspector budget. Inspect the complete saved revision through the administrator API.</p>}</div></details> : null}
    <details open className="mt-4"><summary className="cursor-pointer text-sm font-semibold">Observed definition · inputs, outputs, roles, and constraints</summary><div className="mt-3 max-h-[32rem] overflow-auto pr-2">{complete ? <Fields value={definition} /> : <p className="text-sm">This definition exceeds the readable inspector budget. New review is unavailable; inspect and simplify the contract using the administrator API.</p>}</div></details>
    {canReview ? <div className="mt-5 border-t border-gray-200 pt-4 dark:border-gray-800">
      <p className="text-sm">{operation ? `Operation policy: ${definition.operation_contract?.effect_class || "unsupported"} · ${definition.risk_level} risk · independent exact approval · no automatic replay. This review does not authorize a particular send or ERP change.` : "Supported policy: read-only · low risk · no application replay. This does not approve external email or data sharing."}</p>
      <label className="mt-3 block text-sm font-semibold">Reviewed data sensitivity<select aria-describedby={sensitivityHelp} value={dataClass} onChange={event => { setDataClass(event.target.value); setConfirmed(false); }} className="mt-2 w-full rounded-md border border-gray-300 bg-transparent px-3 py-2 font-normal dark:border-gray-700">
        <option value="">Choose after reviewing the ERP output</option>{sensitivityOptions.filter(option => dataClasses.includes(option.value)).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      <p id={sensitivityHelp} className="mt-2 text-sm text-gray-500">{sensitivityOptions.find(option => option.value === dataClass)?.description ?? "Choose explicitly; a read-only action can still return sensitive data."} This class is a minimum for downstream model use. Separate provider egress review is still required. Changing a saved review invalidates existing workflow capability pins; explicitly republish affected workflows.</p>
      <label className="mt-3 block text-sm font-semibold">Decision note<textarea aria-label="Capability decision note" maxLength={2000} rows={3} value={note} onChange={(event) => setNote(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 bg-transparent p-3 font-normal dark:border-gray-700" /></label>
      <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1" />I inspected this exact contract and understand this changes authority for new dispatch.</label>
      <div className="mt-4 flex flex-wrap gap-2"><Button disabled={!entry.reviewEligible || !complete || !validNote || !confirmed || !validClass} onClick={() => onDecision("review", entry, note, dataClass)}>{operation ? "Save explicit operation review" : "Save explicit read review"}</Button>
        {entry.admission && entry.admission.state !== "DISABLED" ? <Button variant="danger" disabled={!validNote || !confirmed} onClick={() => onDecision("disable", entry, note)}>Disable new dispatch</Button> : null}</div>
    </div> : null}
  </div>;
}
