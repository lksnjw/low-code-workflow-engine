import { Icon } from "@iconify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ErrorState, LoadingState } from "../../components/shared/ResourceState";
import useSemanticStatus from "../../hooks/useSemanticStatus";
import { semanticService } from "../../services/semantic.service";

function DatafeedPage() {
  const queryClient = useQueryClient();
  const status = useSemanticStatus();
  const rebuild = useMutation({
    mutationFn: semanticService.rebuild,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["semantic-index"] }),
  });

  if (status.isLoading) return <LoadingState label="Loading semantic index status…" />;
  if (status.error) return <ErrorState error={status.error} onRetry={status.refetch} />;
  const { health, metadata } = status.data;
  const ready = Boolean(metadata.ready);

  return (
    <div className="space-y-6">
      <section className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div><p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">Semantic retrieval</p><h1 className="page-heading mt-3 text-gray-950 dark:text-white">Index Status</h1><p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">Live status reported by the configured semantic search service.</p></div>
        <button onClick={() => rebuild.mutate()} disabled={rebuild.isPending} className="inline-flex w-fit items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-bold text-blue-700 disabled:opacity-70 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-300"><Icon icon={rebuild.isPending ? "mdi:loading" : "mdi:database-refresh"} className={`h-5 w-5 ${rebuild.isPending ? "animate-spin" : ""}`} />{rebuild.isPending ? "Rebuilding…" : "Rebuild Index"}</button>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Metric label="Index state" value={ready ? "Ready" : "Not ready"} />
        <Metric label="Documents" value={metadata.document_count ?? health.documents ?? 0} />
        <Metric label="Dimensions" value={metadata.index_dimensions ?? "—"} />
        <Metric label="Startup time" value={formatSeconds(health.startup_seconds)} />
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Details title="Embedding" icon="mdi:vector-point" rows={[["Provider", metadata.embedding_provider || health.embedding_provider], ["Model", metadata.embedding_model || health.embedding_model], ["Retrieval method", metadata.retrieval_method || health.method]]} />
        <Details title="Index" icon="mdi:database-search" rows={[["Profile", metadata.index_profile || health.index_profile], ["FAISS entries", metadata.faiss_index_size], ["Cache hit", String(metadata.cache_hit ?? health.cache_hit ?? false)]]} />
      </section>
      {rebuild.error ? <ErrorState error={rebuild.error} /> : null}
      {rebuild.isSuccess ? <p className="text-sm font-semibold text-emerald-600">Semantic index rebuilt successfully.</p> : null}
    </div>
  );
}

function Metric({ label, value }) { return <div className="surface-panel rounded-2xl p-5"><p className="text-sm font-semibold text-gray-500">{label}</p><p className="mt-2 text-2xl font-black text-gray-950 dark:text-white">{value}</p></div>; }
function Details({ title, icon, rows }) { return <div className="surface-panel rounded-2xl p-5"><h2 className="section-title flex items-center gap-2"><Icon icon={icon} className="h-5 w-5 text-primary" />{title}</h2><dl className="mt-5 space-y-3">{rows.map(([label, value]) => <div key={label} className="flex items-center justify-between border-b border-gray-100 pb-3 last:border-0 dark:border-gray-800"><dt className="text-sm text-gray-500">{label}</dt><dd className="max-w-[65%] break-all text-right text-sm font-semibold text-gray-950 dark:text-white">{value ?? "—"}</dd></div>)}</dl></div>; }
function formatSeconds(value) { return Number.isFinite(value) ? `${Number(value).toFixed(2)}s` : "—"; }

export default DatafeedPage;
