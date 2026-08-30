import Card from "../shared/ui/Card";

/*******************************************************************************
 * Function: PermissionMatrix
 *
 * Performs the Permission Matrix operation on matrix for the PermissionMatrix module.
 ******************************************************************************/
function PermissionMatrix({ rows = [] }) {
/*******************************************************************************
 * Function: permissionKeys
 *
 * Performs the permission Keys operation on keys for the PermissionMatrix module.
 ******************************************************************************/
  const permissionKeys = Array.from(new Set(rows.flatMap((row) => Object.keys(row.permissions || {}))));
  return <Card><h2 className="section-title">Permission Matrix</h2>{rows.length === 0 ? <p className="mt-5 text-sm text-gray-500">No role data available.</p> : <div className="mt-5 overflow-auto rounded-2xl border border-gray-200 text-sm dark:border-gray-800"><div className="min-w-[680px]"><div className="grid border-b border-gray-200 bg-gray-50 p-3 font-bold dark:border-gray-800 dark:bg-gray-900" style={{ gridTemplateColumns: `200px repeat(${permissionKeys.length}, minmax(90px, 1fr))` }}><span>Role</span>{permissionKeys.map((key) => <span key={key}>{key}</span>)}</div>{rows.map((row) => <div key={row.role} className="grid border-b border-gray-100 p-3 last:border-0 dark:border-gray-800" style={{ gridTemplateColumns: `200px repeat(${permissionKeys.length}, minmax(90px, 1fr))` }}><span className="font-bold text-gray-950 dark:text-white">{row.role}</span>{permissionKeys.map((key) => <span key={key}>{row.permissions?.[key] ? "Yes" : "—"}</span>)}</div>)}</div></div>}</Card>;
}

export default PermissionMatrix;
