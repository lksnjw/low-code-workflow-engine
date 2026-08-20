import { useMemo, useState } from "react";
import Card from "../../components/shared/ui/Card";
import { ErrorState, LoadingState } from "../../components/shared/ResourceState";
import PermissionMatrix from "../../components/users/PermissionMatrix";
import RoleCreateForm, { restrictPermissionsToCaller } from "../../components/users/RoleCreateForm";
import RolePermissionEditor from "../../components/users/RolePermissionEditor";
import UserForm from "../../components/users/UserForm";
import UserTable from "../../components/users/UserTable";
import { useAuthContext } from "../../context/AuthContext";
import { useNotifications } from "../../context/NotificationContext";
import { usePermissions } from "../../hooks/usePermissions";
import { useUsers } from "../../hooks/useUsers";
import { apiErrorMessage } from "../../services/api";
import { userService } from "../../services/user.service";

function UserListPage({ view = "directory" }) {
  const { user, refreshUser } = useAuthContext();
  const { notify } = useNotifications();
  const { has, roleId } = usePermissions();
  const { data, loading, error, reload } = useUsers();
  const [busyUserId, setBusyUserId] = useState("");
  const [savingRole, setSavingRole] = useState(false);
  const canManage = has("user:manage");
  const callerPermissions = useMemo(
    () => Array.isArray(user?.permissions) ? user.permissions : [],
    [user]
  );
  const grantablePermissions = useMemo(
    () => restrictPermissionsToCaller(data?.permissions || [], callerPermissions),
    [data?.permissions, callerPermissions]
  );
  const assignableRoles = useMemo(
    () => {
      const held = new Set(callerPermissions);
      return (data?.roles || []).filter((role) => {
        if (roleId === "role_system_admin" && (role.id === "role_admin" || role.id === "role_system_admin")) {
          return false;
        }
        return (role.permissions || []).every((permission) => held.has(permission));
      });
    },
    [data?.roles, callerPermissions, roleId]
  );
  const editableRoles = useMemo(
    () => roleId === "role_system_admin"
      ? (data?.roles || []).filter((role) => role.id !== "role_admin" && role.id !== "role_system_admin")
      : (data?.roles || []),
    [data?.roles, roleId]
  );

  const updateUser = async (userId, operation, successMessage) => {
    setBusyUserId(userId);
    try {
      await operation();
      notify(successMessage, "success");
      await reload();
    } catch (requestError) {
      notify(apiErrorMessage(requestError, "Could not update user."), "error");
    } finally {
      setBusyUserId("");
    }
  };

  const saveRole = async (selectedRoleId, permissions) => {
    setSavingRole(true);
    try {
      await userService.updateRoleDefinition(selectedRoleId, { permissions });
      await refreshUser();
      notify("Role permissions updated.", "success");
      await reload();
    } catch (requestError) {
      notify(apiErrorMessage(requestError, "Could not update role permissions."), "error");
    } finally {
      setSavingRole(false);
    }
  };

  const createRole = async (payload) => {
    await userService.createRole(payload);
    notify("Role created.", "success");
    await reload();
  };

  const deleteRole = async (selectedRoleId) => {
    await userService.deleteRole(selectedRoleId);
    notify("Role deleted.", "success");
    await reload();
  };

  if (loading) return <LoadingState label="Loading users and permissions..." />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const headings = {
    directory: ["User Directory", "Create accounts, assign roles, and change active status."],
    roles: ["Roles & Permissions", "Manage role definitions and inspect the effective permission matrix."],
  };
  const [title, description] = headings[view] || headings.directory;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-heading text-gray-950 dark:text-white">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-gray-500 dark:text-gray-400">{description}</p>
      </div>
      {view === "directory" ? (
        <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <UserTable
            users={data?.users}
            roles={assignableRoles}
            departments={data?.departments}
            currentUserId={user?.id}
            canManage={canManage}
            busyUserId={busyUserId}
            onRoleChange={(userId, nextRoleId) => updateUser(
              userId,
              () => userService.updateRole(userId, nextRoleId),
              "User role updated."
            )}
            onStatusChange={(userId, status) => updateUser(
              userId,
              () => userService.updateStatus(userId, status),
              status === "suspended" ? "User suspended." : "User reactivated."
            )}
            onDepartmentChange={(userId, departmentId) => updateUser(
              userId,
              () => userService.updateDepartment(userId, departmentId),
              "User department updated."
            )}
          />
          <Card>
            <h2 className="section-title mb-5">Create User</h2>
            <UserForm roles={assignableRoles} departments={data?.departments} onCreated={reload} />
          </Card>
        </section>
      ) : null}
      {view === "roles" ? (
        <section className="space-y-4">
          <RolePermissionEditor
            roles={editableRoles}
            permissions={grantablePermissions}
            canManage={canManage}
            saving={savingRole}
            onSave={saveRole}
            onDelete={deleteRole}
          />
          <RoleCreateForm
            permissions={data?.permissions}
            callerPermissions={callerPermissions}
            canManage={canManage}
            onCreate={createRole}
          />
          <PermissionMatrix rows={data?.matrix} />
        </section>
      ) : null}
    </div>
  );
}

export default UserListPage;
