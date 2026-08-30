import { Icon } from "@iconify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import RegistryStatusBanner from "../../components/registry/RegistryStatusBanner";
import { EmptyState, ErrorState, LoadingState } from "../../components/shared/ResourceState";
import Button from "../../components/shared/ui/Button";
import usePermissions from "../../hooks/usePermissions";
import { apiErrorMessage } from "../../services/api";
import { registryService } from "../../services/registry.service";

/*******************************************************************************
 * Function: RegistryContextPage
 *
 * Performs the Registry Context Page operation on context page for the RegistryContextPage module.
 ******************************************************************************/
function RegistryContextPage() {
  const queryClient = useQueryClient();
  const { has } = usePermissions();
  const [copied, setCopied] = useState(false);
  const contextQuery = useQuery({ queryKey: ["registry-context"], queryFn: registryService.context });
  const historyQuery = useQuery({ queryKey: ["registry-context-history"], queryFn: registryService.contextHistory });
/*******************************************************************************
 * Function: regenerate
 *
 * Performs the regenerate operation on the application for the RegistryContextPage module.
 ******************************************************************************/
  const regenerate = useMutation({
    mutationFn: registryService.regenerateContext,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["registry-context"] }),
        queryClient.invalidateQueries({ queryKey: ["registry-context-history"] }),
      ]);
    },
  });

  if (contextQuery.isLoading) return <LoadingState label="Loading registry generation context…" />;
  if (contextQuery.error) return <ErrorState error={contextQuery.error} onRetry={contextQuery.refetch} />;
  const document = contextQuery.data;
  if (!document?.markdown) {
    return <EmptyState title="No generation context" description="Generate the runtime registry context before using it for workflow synthesis." />;
  }

/*******************************************************************************
 * Function: copyMarkdown
 *
 * Performs the copy Markdown operation on markdown for the RegistryContextPage module.
 ******************************************************************************/
  const copyMarkdown = async () => {
    await navigator.clipboard.writeText(document.markdown);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="space-y-6 pb-12">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">Generation grounding</p>
          <h1 className="page-heading mt-3 text-gray-950 dark:text-white">Registry context</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">
            Read-only Markdown generated from the typed runtime registry for workflow generation. Validation never reads this file.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={copyMarkdown}>
            <Icon icon={copied ? "mdi:check" : "mdi:content-copy"} className="h-4 w-4" />
            {copied ? "Copied" : "Copy Markdown"}
          </Button>
          {has("registry:write") ? (
            <Button onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
              <Icon icon="mdi:refresh" className="h-4 w-4" />
              {regenerate.isPending ? "Regenerating…" : "Regenerate"}
            </Button>
          ) : null}
        </div>
      </header>

      <RegistryStatusBanner />

      {document.stale ? (
        <section className="rounded-2xl border border-red-300 bg-red-50 p-5 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
          <p className="font-bold">Warning: context hash does not match the active registry.</p>
          <p className="mt-1">Do not use this Markdown for generation until synchronous regeneration succeeds.</p>
        </section>
      ) : null}

      {regenerate.error ? (
        <section className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">
          {apiErrorMessage(regenerate.error, "Registry context regeneration failed.")}
        </section>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="Registry hash" value={document.frontMatter?.registryHash} mono />
        <Metric label="Generated" value={document.frontMatter?.generatedAt} />
        <Metric label="Size" value={`${document.sizeBytes?.toLocaleString() || 0} bytes`} />
        <Metric label="Token estimate" value={document.tokenEstimate?.toLocaleString() || "0"} />
        <Metric label="Contents" value={`${document.frontMatter?.toolCount || 0} tools · ${document.frontMatter?.ruleCount || 0} rules`} />
      </section>

      <section className="surface-panel rounded-2xl p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="section-title">Raw Markdown</h2>
          <span className="rounded-full bg-blue-100 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
            Generation only
          </span>
        </div>
        <pre className="mt-4 max-h-[48rem] overflow-auto whitespace-pre-wrap rounded-xl bg-gray-950 p-5 font-mono text-xs leading-6 text-gray-100">
          {document.markdown}
        </pre>
      </section>

      <section>
        <h2 className="section-title mb-4">Archived registry hashes</h2>
        {historyQuery.isLoading ? (
          <LoadingState label="Loading context history…" />
        ) : historyQuery.error ? (
          <ErrorState error={historyQuery.error} onRetry={historyQuery.refetch} />
        ) : historyQuery.data?.length ? (
          <div className="surface-panel divide-y divide-gray-100 overflow-hidden rounded-2xl dark:divide-gray-800">
            {historyQuery.data.map((item) => (
              <div key={`${item.frontMatter?.registryHash}-${item.frontMatter?.generatedAt}`} className="grid gap-2 p-4 text-sm lg:grid-cols-[minmax(0,1fr)_12rem_8rem]">
                <span className="break-all font-mono text-xs text-gray-700 dark:text-gray-200">{item.frontMatter?.registryHash}</span>
                <span className="text-gray-500">{item.frontMatter?.generatedAt}</span>
                <span className="text-right font-semibold text-gray-600 dark:text-gray-300">{item.sizeBytes?.toLocaleString()} bytes</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No archived contexts" description="Archived versions appear after the first successful generation." />
        )}
      </section>
    </div>
  );
}

/*******************************************************************************
 * Function: Metric
 *
 * Performs the Metric operation on the application for the RegistryContextPage module.
 ******************************************************************************/
function Metric({ label, value, mono = false }) {
  return (
    <div className="surface-panel min-w-0 rounded-2xl p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-gray-500">{label}</p>
      <p className={`mt-2 break-all text-sm font-semibold text-gray-950 dark:text-white ${mono ? "font-mono text-xs" : ""}`}>{value || "Unavailable"}</p>
    </div>
  );
}

export default RegistryContextPage;
