import { Icon } from "@iconify/react";
import { useQuery } from "@tanstack/react-query";
import { ErrorState, EmptyState, LoadingState } from "../../components/shared/ResourceState";
import { catalogService } from "../../services/catalog.service";
import { dashboardService } from "../../services/dashboard.service";

/*******************************************************************************
 * Function: McpBridgePage
 *
 * Performs the Mcp Bridge Page operation on bridge page for the McpBridgePage module.
 ******************************************************************************/
function McpBridgePage() {
/*******************************************************************************
 * Function: query
 *
 * Performs the query operation on the application for the McpBridgePage module.
 ******************************************************************************/
  const query = useQuery({
    queryKey: ["mcp-bridge"],
    queryFn: async () => {
      const [dashboard, tools] = await Promise.all([dashboardService.load(), catalogService.tools()]);
      return { health: dashboard.health, tools };
    },
    refetchInterval: 30_000,
  });

  if (query.isLoading) return <LoadingState label="Loading MCP bridge status…" />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
/*******************************************************************************
 * Function: mcp
 *
 * Performs the mcp operation on the application for the McpBridgePage module.
 ******************************************************************************/
  const mcp = query.data.health.services?.find((service) => service.name === "MCP Bridge");
  const configured = mcp?.status === "healthy";

  return (
    <div className="space-y-6 pb-10">
      <section className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">Infrastructure & Integration</p>
          <h1 className="page-heading mt-3 text-gray-950 dark:text-white">MCP Bridge</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">Runtime configuration and the registered workflow tool catalog.</p>
        </div>
        <span className={`inline-flex w-fit items-center gap-2 rounded-full border px-4 py-2 text-sm font-bold ${configured ? "border-green-200 bg-green-50 text-green-700 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-300" : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300"}`}>
          <Icon icon="mdi:server-network" className="h-5 w-5" />
          {configured ? "Configured" : "Not configured"}
        </span>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <Metric label="Bridge status" value={mcp?.status || "unknown"} />
        <Metric label="Registered tools" value={query.data.tools.length} />
        <Metric label="Platform health" value={query.data.health.overall || "unknown"} />
      </section>

      <section className="surface-panel rounded-2xl p-6">
        <div className="flex items-center justify-between border-b border-gray-100 pb-4 dark:border-gray-800">
          <h2 className="section-title flex items-center gap-2"><Icon icon="mdi:toolbox" className="h-5 w-5 text-primary" />Tool Registry</h2>
          <button onClick={() => query.refetch()} className="rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-bold text-primary">Refresh</button>
        </div>
        {query.data.tools.length === 0 ? <div className="mt-4"><EmptyState title="No tools registered" description="Load a registry dataset on the backend to make tools available." /></div> : (
          <div className="mt-4 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead><tr className="border-b border-gray-100 text-xs text-gray-500 dark:border-gray-800"><th className="pb-2 font-medium">Tool</th><th className="pb-2 font-medium">System</th><th className="pb-2 font-medium">Module</th><th className="pb-2 text-right font-medium">Status</th></tr></thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {query.data.tools.map((tool) => <tr key={tool.tool_id}><td className="py-3"><p className="font-bold text-gray-900 dark:text-white">{tool.display_name || tool.name}</p><p className="font-mono text-[10px] text-gray-500">{tool.tool_id}</p></td><td className="py-3 text-gray-600 dark:text-gray-300">{tool.erp_system || "—"}</td><td className="py-3 text-gray-600 dark:text-gray-300">{tool.module || "—"}</td><td className="py-3 text-right text-xs font-bold">{tool.status}</td></tr>)}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="surface-panel rounded-2xl p-5">
        <h2 className="section-title">Runtime endpoint</h2>
        <p className="mt-2 break-all font-mono text-sm text-gray-500">{mcp?.meta || "not configured"}</p>
        <p className="mt-3 text-xs text-gray-500">The bridge address is managed by backend environment configuration and is never invented or stored in the browser.</p>
      </section>
    </div>
  );
}

/*******************************************************************************
 * Function: Metric
 *
 * Performs the Metric operation on the application for the McpBridgePage module.
 ******************************************************************************/
function Metric({ label, value }) {
  return <div className="surface-panel rounded-2xl p-5"><p className="text-sm font-semibold text-gray-500 dark:text-gray-400">{label}</p><p className="mt-2 text-2xl font-black capitalize text-gray-950 dark:text-white">{value}</p></div>;
}

export default McpBridgePage;
