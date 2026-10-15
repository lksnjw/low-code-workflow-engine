import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { registryService } from "../../services/registry.service";
import { EmptyState, ErrorState, LoadingState } from "../shared/ResourceState";
import Button from "../shared/ui/Button";

export default function LiveErpToolsPanel() {
  const [offset, setOffset] = useState(0), [search, setSearch] = useState(""), [draftSearch, setDraftSearch] = useState("");
  const [connectionId, setConnectionId] = useState(""), [selected, setSelected] = useState(null), [revision, setRevision] = useState(0);
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["live-erp-tools", connectionId, revision],
    queryFn: () => registryService.liveTools({ limit: "all", connectionId }),
    staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnMount: "always" });
  const detail = useQuery({ queryKey: ["live-erp-tool-detail", connectionId, selected, revision],
    queryFn: () => registryService.liveTools({ toolName: selected, connectionId }), enabled: selected !== null,
    staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: false });
  // Fetch one compact inventory; search/pages are immediate local projections.
  // Full remote contracts are fetched only when an exact tool is inspected.
  const data = useMemo(() => {
    if (!query.data) return null;
    const term = search.toLowerCase(), matches = query.data.tools.filter(tool => !term || `${tool.name} ${tool.description}`.toLowerCase().includes(term));
    const pageOffset = matches.length ? Math.min(offset, Math.floor((matches.length - 1) / 20) * 20) : 0;
    return { ...query.data, matchedCount: matches.length, offset: pageOffset, limit: 20,
      nextOffset: pageOffset + 20 < matches.length ? pageOffset + 20 : null, tools: matches.slice(pageOffset, pageOffset + 20) };
  }, [query.data, search, offset]);
  const changePage = (value) => { setSelected(null); setOffset(value); };
  const refresh = () => {
    setSelected(null); setOffset(0); setRevision(value => value + 1);
    client.removeQueries({ queryKey: ["live-erp-tool-detail"] });
  };
  return <section aria-label="Live ERPBridge tools" className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="section-title">ERPBridge tools</h2>
        <p className="mt-1 text-sm text-gray-500">Only tools currently exposed by the connected ERPBridge. No built-in or saved fallback entries.</p></div>
      <Button variant="secondary" onClick={refresh} disabled={query.isFetching}>{query.isFetching ? "Loading latest tools…" : "Refresh tools"}</Button>
    </div>
    <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); setSelected(null); setOffset(0); setSearch(draftSearch.trim()); }}>
      <label className="min-w-48 flex-1 text-sm">Search ERPBridge tools
        <input className="mt-1 block w-full rounded-xl border border-gray-300 bg-transparent px-3 py-2 dark:border-gray-700" value={draftSearch} onChange={event => setDraftSearch(event.target.value)} placeholder="Name or description" /></label>
      {data?.connections?.length > 1 ? <label className="text-sm">ERPBridge connection
        <select className="mt-1 block rounded-xl border bg-transparent px-3 py-2" value={connectionId || data.connectionId} onChange={event => { setConnectionId(event.target.value); setOffset(0); setSelected(null); }}>
          {data.connections.map(connection => <option key={connection.id} value={connection.id}>{connection.id}</option>)}
        </select></label> : null}
      <Button type="submit" variant="secondary" disabled={query.isFetching}>Search</Button>
    </form>
    {query.isFetching ? <LoadingState label="Loading latest ERPBridge tools…" /> : query.error ? <ErrorState error={query.error} onRetry={refresh} /> : data ? <>
      <p role="status" className="text-sm text-gray-500">{data.total} tools exposed · {data.matchedCount} matching · {data.connectionId}</p>
      {data.tools.length ? <div role="region" aria-label="ERPBridge tool list" className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
        <table className="min-w-full text-left text-sm"><thead className="bg-gray-50 dark:bg-gray-900"><tr>
          <th className="px-4 py-3">Tool</th><th className="px-4 py-3">Effect</th><th className="px-4 py-3">Details</th>
        </tr></thead><tbody>{data.tools.map(tool => <tr key={tool.name} className="border-t border-gray-100 dark:border-gray-800">
          <td className="px-4 py-3"><p className="font-mono font-semibold">{tool.name}</p><p className="mt-1 max-w-3xl text-xs text-gray-500 line-clamp-2">{tool.description}</p></td>
          <td className="px-4 py-3 whitespace-nowrap">{tool.effect === "READ" ? "Read" : "Change / other"}</td>
          <td className="px-4 py-3"><Button variant="ghost" onClick={() => setSelected(tool.name)} aria-label={`View ${tool.name}`}>View</Button></td>
        </tr>)}</tbody></table>
      </div> : <EmptyState title="No matching ERPBridge tools" description="Try another search or refresh the bridge inventory." />}
      <nav aria-label="ERPBridge tool pages" className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-500">{data.matchedCount ? `${data.offset + 1}–${Math.min(data.offset + data.limit, data.matchedCount)} of ${data.matchedCount}` : "0 tools"} · Page {Math.floor(data.offset / data.limit) + 1}</p>
        <div className="flex gap-2"><Button variant="secondary" disabled={data.offset === 0} onClick={() => changePage(Math.max(0, data.offset - data.limit))}>Previous tools</Button>
          <Button variant="secondary" disabled={data.nextOffset === null} onClick={() => changePage(data.nextOffset)}>Next tools</Button></div>
      </nav>
      <p className="text-xs text-gray-500">Loaded {new Date(data.discoveredAt).toLocaleTimeString()} · Discovery is not proof of execution permission. Token permissions, validation and confirmations still apply.</p>
      {selected ? <section aria-label="ERPBridge tool definition" className="surface-panel rounded-xl p-4">
        <div className="flex items-center justify-between gap-3"><h3 className="font-semibold break-all">{selected}</h3><Button variant="ghost" onClick={() => setSelected(null)}>Close detail</Button></div>
        {detail.isFetching ? <LoadingState label="Loading current tool schema…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refetch} /> : detail.data?.tool ?
          <pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-gray-950 p-4 text-xs text-gray-100">{JSON.stringify(detail.data.tool, null, 2)}</pre> : null}
      </section> : null}
    </> : null}
  </section>;
}
