import Card from "../shared/ui/Card";

function AuditLogTable({ logs = [] }) {
  return <Card><h2 className="section-title">Audit Trail</h2><div className="mt-5 space-y-2">{logs.length === 0 ? <p className="text-sm text-gray-500">No audit events recorded.</p> : logs.map((log) => <div key={log.id} className="grid grid-cols-[110px_1fr_1.3fr] gap-3 rounded-xl bg-backgroundLight p-3 text-sm dark:bg-darkBackgroundVery"><span className="font-bold text-primary">{new Date(log.createdAt).toLocaleString()}</span><span className="font-semibold text-gray-900 dark:text-white">{log.actor?.name || "System"}</span><span className="text-gray-500 dark:text-gray-400">{log.action}</span></div>)}</div></Card>;
}

export default AuditLogTable;
