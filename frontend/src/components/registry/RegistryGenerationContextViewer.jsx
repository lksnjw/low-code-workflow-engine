import { useQuery } from "@tanstack/react-query";
import { EmptyState, ErrorState, LoadingState } from "../shared/ResourceState";
import { registryService } from "../../services/registry.service";

function RegistryGenerationContextViewer() {
  const query = useQuery({ queryKey: ["registry-context"], queryFn: registryService.context });

  return (
    <section className="surface-panel rounded-2xl p-5" aria-label="Generation context not used for validation">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
        <div>
          <h2 className="section-title">Generation context (not used for validation)</h2>
          <p className="mt-1 text-xs leading-5 text-gray-500">Read-only Markdown supplied to workflow generation. The deterministic gate reads typed JSON only.</p>
        </div>
        {query.data?.frontMatter?.registryHash ? (
          <span className="max-w-72 break-all font-mono text-[10px] text-gray-400">{query.data.frontMatter.registryHash}</span>
        ) : null}
      </div>

      <div className="mt-4">
        {query.isLoading ? (
          <LoadingState label="Loading generation context..." />
        ) : query.error ? (
          <ErrorState error={query.error} onRetry={query.refetch} />
        ) : query.data?.markdown ? (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-gray-950 p-4 font-mono text-xs leading-6 text-gray-100">{query.data.markdown}</pre>
        ) : (
          <EmptyState title="No generation context" description="The context will appear after the runtime registry is generated." />
        )}
      </div>
    </section>
  );
}

export default RegistryGenerationContextViewer;
