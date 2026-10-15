import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import Button from "../../components/shared/ui/Button";
import { ErrorState, LoadingState } from "../../components/shared/ResourceState";
import { ragPolicyService } from "../../services/rag-policy.service";
import { ragPolicySamples, policyDraftText } from "./rag-policy-samples";
import RagPolicyPublisher from "../../components/settings/RagPolicyPublisher";

export default function RagPolicyPage() {
  const status = useQuery({ queryKey: ["rag-policy-status"], queryFn: ragPolicyService.status, retry: false, staleTime: 15000 });
  const [prompt, setPrompt] = useState(""), [busy, setBusy] = useState(false), [result, setResult] = useState(null), [error, setError] = useState("");
  const [recordTest, setRecordTest] = useState(null);
  const test = async event => {
    event.preventDefault(); if (busy || !prompt.trim() || prompt.length > 2000) return;
    setBusy(true); setError(""); setResult(null);
    try { setResult(await (recordTest ? ragPolicyService.test(prompt.trim(), recordTest) : ragPolicyService.test(prompt.trim()))); }
    catch (failure) { setError(failure?.response?.data?.message || failure?.message || "The policy response was not confirmed."); }
    finally { setBusy(false); }
  };
  const download = sample => {
    const url = URL.createObjectURL(new Blob([policyDraftText(sample)], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `${sample.id}.txt`; link.click(); URL.revokeObjectURL(url);
  };
  return <div className="mx-auto max-w-6xl space-y-7">
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-gray-200 pb-5 dark:border-gray-800">
      <div><h1 className="page-heading">RAG policies</h1><p className="mt-2 text-sm text-gray-500">Manage governing rules and test decisions. Uploaded business documents use the separate <Link className="text-primary underline" to="/datafeed/search">pipeline document search</Link>.</p></div>
      <Link to="/settings" className="text-sm text-primary hover:underline">Policy switches</Link>
    </header>
    {status.isLoading ? <LoadingState label="Checking RAG connection…" /> : status.error ? <ErrorState error={status.error} onRetry={status.refetch} /> : <section aria-label="RAG connection" className="space-y-4">
      <div className="flex items-center justify-between gap-4"><p role="status" className="text-sm font-semibold">{status.data?.state === "CONNECTED" ? "Connected directly through the backend" : "RAG connection needs attention"}</p><Button variant="secondary" disabled={status.isFetching} onClick={() => status.refetch()}>{status.isFetching ? "Checking…" : "Refresh connection"}</Button></div>
      {status.data?.health && <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm lg:grid-cols-4">{[["Finance policy store", status.data.health.policy_collection], ["Finance policy chunks", status.data.health.policy_chunks], ["Supported actions", (status.data.actions?.length ?? 0) + (status.data.record_actions?.length ?? 0)], ["RAG switch", status.data.switches?.remote ? "On" : "Off"]].map(([label, value]) => <div key={label}><dt className="text-xs text-gray-500">{label}</dt><dd className="mt-1 font-medium">{value}</dd></div>)}</dl>}
      <p className="text-xs leading-5 text-gray-500">Keys stay on the server. A connected service does not mean every ERP action is covered.</p>
    </section>}
    <section className="grid gap-7 border-t border-gray-200 pt-6 dark:border-gray-800 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <form onSubmit={test} className="space-y-4" aria-label="Test a policy">
        <div><h2 className="text-lg font-semibold">Test a policy</h2><p className="mt-1 text-sm text-gray-500">Uses your signed-in role. This test never executes the suggested action.</p></div>
        <label className="block text-sm font-medium" htmlFor="rag-prompt">Question or proposed action</label>
        <textarea id="rag-prompt" rows={5} maxLength={2000} value={prompt} disabled={busy} onChange={event => { setPrompt(event.target.value); setRecordTest(null); }} placeholder="What checks are required before approving an invoice?" className="w-full rounded-xl border border-gray-300 bg-transparent p-3 text-sm focus:border-primary focus:outline-none dark:border-gray-700" />
        <div className="flex flex-wrap gap-2">{["What checks are required before approving an invoice?", "Can I delete this customer record?", "Can I register a customer if the customer name is missing?"].map((value, index) => <button key={value} type="button" disabled={busy} onClick={() => { setPrompt(value); setRecordTest(index === 1 ? { action: "delete_record", arguments: { doctype: "Customer", name: "policy-check-only" } } : index === 2 ? { action: "create_customer", arguments: {} } : null); }} className="text-left text-xs text-primary underline-offset-4 hover:underline disabled:opacity-50">{value}</button>)}</div>
        {recordTest && <p className="text-xs text-gray-500">Checks a fixed example against the record-rule store. No business record is read or changed.</p>}
        <Button type="submit" disabled={busy || !prompt.trim() || !status.data?.configured}>{busy ? "Checking policy…" : "Check policy"}</Button>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      </form>
      <section aria-label="Policy result" aria-live="polite" className="min-w-0 border-l border-gray-200 pl-6 dark:border-gray-800">
        <h2 className="text-lg font-semibold">Result</h2>
        {result ? <div className="mt-4 space-y-3 text-sm"><p className="font-semibold">{result.decision} · {result.request_type}</p><p>{result.reason}</p>{result.knowledge && <p className="whitespace-pre-wrap">{result.knowledge}</p>}<p className="text-xs text-gray-500">Retrieved clauses: {result.retrieval?.total_unique ?? 0} · Citations: {result.citations?.length ?? 0}</p>{!result.citations?.length && <p className="text-amber-700 dark:text-amber-300">No cited policy evidence was returned. Do not treat this answer as a validated business approval.</p>}<p className="text-xs text-gray-500">{result.warning} No ERP operation was performed.</p><details><summary className="cursor-pointer text-primary">Conditions and citations</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ conditions: result.conditions, citations: result.citations }, null, 2)}</pre></details></div> : <p className="mt-4 text-sm text-gray-500">{busy ? "Waiting for a decision, up to ten seconds…" : "Ask a question to see its decision, evidence and unmet conditions here."}</p>}
      </section>
    </section>
    {result?.conditions?.length > 0 && <section aria-label="Required policy actions" className="border-l-2 border-amber-500 pl-4 text-sm"><h2 className="font-semibold">What needs attention</h2><ul className="mt-2 list-disc space-y-2 pl-5">{result.conditions.map((condition, index) => <li key={index}>{typeof condition?.description === "string" ? condition.description : "Review the returned policy condition before continuing."}</li>)}</ul></section>}
    <RagPolicyPublisher available={status.data?.policyImportAvailable} reason={status.data?.policyImportReason} policies={status.data?.policies} onPublished={() => status.refetch()} />
    <section className="space-y-4 border-t border-gray-200 pt-6 dark:border-gray-800" aria-label="Policy drafts">
      <div><h2 className="text-lg font-semibold">Extended policy drafts</h2><p className="mt-1 text-sm text-gray-500">Downloadable design drafts only. Their wider prose is not automatically enforced; use reviewed record rules above for supported checks.</p></div>
      <p className="text-sm text-amber-700 dark:text-amber-300">Do not upload these as ordinary customer documents: document storage does not make text governing policy. An authenticated RAG ingestion API and matching action coverage are required.</p>
      {ragPolicySamples.map(sample => <article key={sample.id} className="border-b border-gray-100 py-4 last:border-0 dark:border-gray-800"><div className="flex flex-wrap items-start justify-between gap-4"><div><h3 className="font-semibold">{sample.title}</h3><p className="mt-1 max-w-2xl text-sm text-gray-500">{sample.summary}</p><p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Draft · not enforced by RAG</p></div><Button variant="secondary" onClick={() => download(sample)}>Download draft</Button></div><details className="mt-3 text-sm"><summary className="cursor-pointer text-primary">Review clauses</summary><p className="mt-3 max-w-3xl whitespace-pre-wrap leading-6">{sample.text}</p></details></article>)}
    </section>
    <details className="border-t border-gray-200 pt-5 text-sm dark:border-gray-800"><summary className="cursor-pointer font-semibold">Supported RAG action contracts</summary><p className="mt-2 text-xs text-gray-500">Unsupported actions need a registry update; the assistant must not silently map customer creation or deletion to a finance action.</p><ul className="mt-3 divide-y divide-gray-100 dark:divide-gray-800">{[...(status.data?.actions ?? []), ...(status.data?.record_actions ?? [])].map(action => <li key={action.name} className="py-3"><span className="font-medium">{action.name.replaceAll("_", " ")}</span><p className="mt-1 text-gray-500">{action.description}</p></li>)}</ul></details>
  </div>;
}
