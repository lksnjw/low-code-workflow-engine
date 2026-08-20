import { useQuery } from "@tanstack/react-query";
import { ErrorState, LoadingState } from "../../components/shared/ResourceState";
import AuditLogTable from "../../components/users/AuditLogTable";
import { userService } from "../../services/user.service";

function AuditPage() {
  const query = useQuery({ queryKey: ["audit-log"], queryFn: () => userService.loadAudit() });

  if (query.isLoading) return <LoadingState label="Loading audit events…" />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;

  const logs = query.data?.logs ?? [];
  const total = Number(query.data?.meta?.total);
  const hasTotal = Number.isFinite(total);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-heading text-gray-950 dark:text-white">Audit Logs</h1>
        <p className="mt-3 text-sm leading-6 text-gray-500 dark:text-gray-400">
          Review recorded administrative and governance actions.
        </p>
      </div>
      {hasTotal ? (
        <p className="text-sm font-semibold text-gray-600 dark:text-gray-300">
          Showing {logs.length.toLocaleString()} of {total.toLocaleString()} audit events.
        </p>
      ) : null}
      <AuditLogTable logs={logs} />
    </div>
  );
}

export default AuditPage;
