import { Icon } from "@iconify/react";
import { ErrorState, LoadingState } from "../../components/shared/ResourceState";
import useSemanticStatus from "../../hooks/useSemanticStatus";

function PipelineConfigPage() {
  const status = useSemanticStatus();
  if (status.isLoading) return <LoadingState label="Loading pipeline configuration…" />;
  if (status.error) return <ErrorState error={status.error} onRetry={status.refetch} />;
  const { health, metadata } = status.data;
  const entries = [
    ["Dataset root", metadata.dataset_root || health.dataset_root], ["Index profile", metadata.index_profile || health.index_profile],
    ["Retrieval method", metadata.retrieval_method || health.method], ["Embedding provider", metadata.embedding_provider || health.embedding_provider],
    ["Embedding model", metadata.embedding_model || health.embedding_model], ["Maximum items per file", health.max_items_per_file],
    ["Maximum items by kind", formatObject(metadata.max_items_by_kind || health.max_items_by_kind)], ["Cache enabled", String(metadata.cache_enabled ?? health.cache_enabled ?? false)],
  ];
  return <div className="space-y-6"><section><p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">Runtime settings</p><h1 className="page-heading mt-3 text-gray-950 dark:text-white">Pipeline Configuration</h1><p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">Effective read-only configuration reported by the semantic service. Change these values in the service environment and restart it.</p></section><section className="surface-panel rounded-2xl p-6"><h2 className="section-title flex items-center gap-2 border-b border-gray-100 pb-4 dark:border-gray-800"><Icon icon="mdi:database-cog" className="h-5 w-5 text-primary" />Effective configuration</h2><dl className="mt-5 grid gap-x-8 md:grid-cols-2">{entries.map(([label, value]) => <div key={label} className="border-b border-gray-100 py-4 dark:border-gray-800"><dt className="text-xs font-bold uppercase tracking-wide text-gray-500">{label}</dt><dd className="mt-2 break-all font-mono text-sm text-gray-950 dark:text-white">{value ?? "—"}</dd></div>)}</dl></section></div>;
}

function formatObject(value) { return value && typeof value === "object" ? Object.entries(value).map(([key, count]) => `${key}: ${count}`).join(", ") : value; }

export default PipelineConfigPage;
