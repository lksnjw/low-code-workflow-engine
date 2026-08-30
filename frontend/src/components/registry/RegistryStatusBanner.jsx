import { Icon } from "@iconify/react";
import { useQuery } from "@tanstack/react-query";
import { registryService } from "../../services/registry.service";

/*******************************************************************************
 * Function: RegistryStatusBanner
 *
 * Performs the Registry Status Banner operation on status banner for the RegistryStatusBanner module.
 ******************************************************************************/
function RegistryStatusBanner() {
  const query = useQuery({ queryKey: ["registry-status"], queryFn: registryService.status });

  if (query.isLoading) {
    return (
      <section className="surface-panel animate-pulse rounded-2xl p-5" aria-label="Loading active registry status">
        <div className="h-4 w-40 rounded bg-gray-200 dark:bg-gray-800" />
        <div className="mt-4 h-3 w-full rounded bg-gray-100 dark:bg-gray-900" />
        <div className="mt-2 h-3 w-3/4 rounded bg-gray-100 dark:bg-gray-900" />
      </section>
    );
  }

  if (query.error) {
    return (
      <section className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-200">
        <p className="font-bold">Active registry status is unavailable.</p>
        <button type="button" onClick={() => query.refetch()} className="mt-2 font-semibold underline underline-offset-2">
          Try again
        </button>
      </section>
    );
  }

  const status = query.data || {};
  const writable = Boolean(status.writable);
  return (
    <section className="surface-panel rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon icon="mdi:database-cog-outline" className="h-5 w-5 text-primary" />
          <h2 className="text-sm font-bold text-gray-950 dark:text-white">Active registry files</h2>
        </div>
        <span className={`rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] ${writable ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200" : "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"}`}>
          {writable ? "Runtime · writable" : "Read-only"}
        </span>
      </div>
      <dl className="mt-4 grid gap-4 lg:grid-cols-2">
        {[
          ["Tools", status.tools],
          ["Rules", status.rules],
        ].map(([label, value]) => (
          <div key={label} className="min-w-0 rounded-xl bg-gray-50 p-4 dark:bg-gray-950/40">
            <dt className="text-[10px] font-bold uppercase tracking-[0.16em] text-gray-500">{label}</dt>
            <dd className="mt-2 break-all font-mono text-[11px] text-gray-700 dark:text-gray-200">{value?.path || "Path unavailable"}</dd>
            <dd className="mt-1 break-all font-mono text-[10px] text-gray-400">sha256:{value?.sha256 || "unavailable"}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default RegistryStatusBanner;
