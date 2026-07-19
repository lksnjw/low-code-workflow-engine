import { Icon } from "@iconify/react";
import { ErrorState, LoadingState } from "../../components/shared/ResourceState";
import useSemanticStatus from "../../hooks/useSemanticStatus";

function VectorMetricsPage() {
  const status = useSemanticStatus();
  if (status.isLoading) return <LoadingState label="Loading vector metrics…" />;
  if (status.error) return <ErrorState error={status.error} onRetry={status.refetch} />;
  const { health, metadata } = status.data;
  const metrics = [
    ["Indexed documents", metadata.document_count ?? health.documents ?? 0, "mdi:file-document-multiple-outline"],
    ["FAISS entries", metadata.faiss_index_size ?? 0, "mdi:database-outline"],
    ["Vector dimensions", metadata.index_dimensions ?? "—", "mdi:vector-point"],
    ["Startup seconds", Number.isFinite(health.startup_seconds) ? Number(health.startup_seconds).toFixed(3) : "—", "mdi:timer-outline"],
  ];
  return <div className="space-y-6"><section><p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">Live metrics</p><h1 className="page-heading mt-3 text-gray-950 dark:text-white">Semantic Index Metrics</h1><p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">Current counters from the semantic index. Historical charts are omitted because the service does not expose time-series data.</p></section><section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{metrics.map(([label, value, icon]) => <div key={label} className="surface-panel rounded-2xl p-5"><Icon icon={icon} className="h-6 w-6 text-primary" /><p className="mt-5 text-sm font-semibold text-gray-500">{label}</p><p className="mt-2 text-3xl font-black text-gray-950 dark:text-white">{value}</p></div>)}</section><section className="surface-panel rounded-2xl p-5"><h2 className="section-title">Data freshness</h2><p className="mt-3 text-sm text-gray-500">Fingerprint</p><p className="mt-1 break-all font-mono text-xs text-gray-900 dark:text-gray-200">{metadata.fingerprint || health.fingerprint || "Unavailable"}</p><p className="mt-4 text-sm text-gray-500">Cache</p><p className="mt-1 text-sm font-semibold text-gray-900 dark:text-white">{metadata.cache_hit ?? health.cache_hit ? "Loaded from cache" : "Built at service startup"}</p></section></div>;
}

export default VectorMetricsPage;
