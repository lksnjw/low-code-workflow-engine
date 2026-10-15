import { useQuery } from "@tanstack/react-query";
import { ErrorState, LoadingState } from "../../components/shared/ResourceState";
import Button from "../../components/shared/ui/Button";
import CollectionSummary from "../../components/datafeed/CollectionSummary";
import { documentWorkspaceService as service } from "../../services/document-workspace.service";
import { useAuthContext } from "../../context/AuthContext";
import { authorityScope } from "../../utils/authAuthority";

export default function VectorMetricsPage() {
  const { user } = useAuthContext();
  const status = useQuery({ queryKey: ["document-collection-metrics", authorityScope(user)],
    queryFn: async () => { const [catalog, inventory] = await Promise.all([service.catalog(), service.inventory()]); return { catalog, inventory }; },
    refetchInterval: 30_000 });
  if (status.isLoading) return <LoadingState label="Loading collection inventory…" />;
  if (status.error) return <ErrorState error={status.error} message={status.error.message} onRetry={status.refetch} />;
  const { catalog, inventory } = status.data;
  return <div className="space-y-6"><header className="flex items-start justify-between gap-4"><div><h1 className="page-heading text-gray-950 dark:text-white">Document collection inventory</h1><p className="mt-2 text-sm text-gray-500">Current private document destinations from the pipeline. Refreshes every 30 seconds; counts are permission-scoped, not global vector point totals.</p></div><Button variant="secondary" disabled={status.isFetching} onClick={() => status.refetch()}>Refresh collections</Button></header>
    <dl className="flex flex-wrap gap-x-10 gap-y-4 border-y border-gray-200 py-4 text-sm dark:border-gray-700">{[["Permitted searchable documents", inventory.searchable_documents], ["Owned pending review", inventory.pending_review], ["Owned index failures", inventory.index_failed], ["Index configuration", inventory.vector_index_configured ? "Configured" : "Unavailable"]].map(([label, value]) => <div key={label}><dt className="text-gray-500">{label}</dt><dd className="mt-1 font-semibold">{value}</dd></div>)}</dl>
    <CollectionSummary catalog={catalog} />
    <p className="text-xs text-gray-500">These counts come from current confirmed database receipts. They do not assert a live Qdrant health check, include old-version vectors, or measure search latency. Historical charts and unavailable FAISS metrics are not shown.</p>
  </div>;
}
