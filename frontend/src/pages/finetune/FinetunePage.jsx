import { useState } from "react";
import { Icon } from "@iconify/react";
import { EmptyState, ErrorState, LoadingState } from "../../components/shared/ResourceState";
import { synthesisService } from "../../services/synthesis.service";

function ResultGroup({ title, items = [], labelKey }) {
  return (
    <section className="surface-panel rounded-2xl p-5">
      <h2 className="section-title">{title}</h2>
      <div className="mt-4 space-y-2">
        {items.length === 0 ? (
          <p className="text-sm text-gray-500">No matches.</p>
        ) : (
          items.map((item, index) => (
            <div key={item[labelKey] || index} className="rounded-xl bg-backgroundLight p-3 dark:bg-darkBackgroundVery">
              <p className="font-semibold text-gray-900 dark:text-white">{item[labelKey] || item.name || item.rule_name || "Match"}</p>
              <p className="mt-1 text-xs text-gray-500">Score: {Number(item.score || 0).toFixed(3)}</p>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function FinetunePage() {
  const [query, setQuery] = useState("");
  const [lastQuery, setLastQuery] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const runSearch = async (searchText) => {
    setLoading(true);
    setFailed(false);
    setLastQuery(searchText);
    try {
      setResult(await synthesisService.semanticSearch(searchText));
    } catch {
      setResult(null);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  const search = (event) => {
    event.preventDefault();
    const searchText = query.trim();
    if (searchText) runSearch(searchText);
  };

  return (
    <div className="space-y-6 pb-10">
      <section>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">Registry Retrieval</p>
        <h1 className="page-heading mt-3 text-gray-950 dark:text-white">Semantic Dataset Search</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">
          Query the tool, rule, template, and example indexes used to ground workflow generation.
        </p>
      </section>
      <form onSubmit={search} className="surface-panel flex gap-3 rounded-2xl p-4">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search registered workflow capabilities…" className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm dark:border-gray-700 dark:bg-darkBackground" />
        <button disabled={loading || !query.trim()} className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-bold text-white disabled:opacity-50">
          <Icon icon="mdi:magnify" className="h-5 w-5" />
          {loading ? "Searching…" : "Search"}
        </button>
      </form>
      {loading ? <LoadingState label={`Searching the semantic index for “${lastQuery}”…`} /> : null}
      {failed ? <ErrorState message="Semantic search could not be completed." onRetry={() => runSearch(lastQuery)} /> : null}
      {!loading && !failed && !result ? (
        <EmptyState title="No search submitted" description="Enter a capability, policy, template, or scenario to inspect registry matches." />
      ) : null}
      {result ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <ResultGroup title="Tools" items={result.tools} labelKey="name" />
          <ResultGroup title="Rules" items={result.rules} labelKey="rule_name" />
          <ResultGroup title="Templates" items={result.templates} labelKey="template_name" />
          <ResultGroup title="Examples" items={result.examples} labelKey="scenario_id" />
        </div>
      ) : null}
    </div>
  );
}

export default FinetunePage;
