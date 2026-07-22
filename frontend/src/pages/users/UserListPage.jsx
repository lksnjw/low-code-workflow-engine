import Card from "../../components/shared/ui/Card";
import AuditLogTable from "../../components/users/AuditLogTable";
import PermissionMatrix from "../../components/users/PermissionMatrix";
import UserForm from "../../components/users/UserForm";
import UserTable from "../../components/users/UserTable";
import { ErrorState, LoadingState } from "../../components/shared/ResourceState";
import { useUsers } from "../../hooks/useUsers";
import { useAuthContext } from "../../context/AuthContext";

function UserListPage() {
  const { user } = useAuthContext();
  const { data, loading, error, reload } = useUsers();
  if (loading) return <LoadingState label="Loading users and permissions…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return <div className="space-y-6"><div><h1 className="page-heading text-gray-950 dark:text-white">Users & Access</h1><p className="mt-3 text-sm leading-6 text-gray-500 dark:text-gray-400">Manage real accounts, roles, permissions, and audit records.</p></div><section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]"><div className="space-y-4"><UserTable users={data?.users} /><PermissionMatrix rows={data?.matrix} /><AuditLogTable logs={data?.audit} /></div><Card><h2 className="section-title mb-5">Create User</h2><UserForm roles={data?.roles} actorRoleId={user?.roleId} onCreated={reload} /></Card></section></div>;
}

export default UserListPage;
