import UserAvatar from "./UserAvatar";
import UserBadge from "./UserBadge";
import Button from "../shared/ui/Button";
import Select from "../shared/ui/Select";

/*******************************************************************************
 * Function: UserRow
 *
 * Performs the User Row operation on row for the UserRow module.
 ******************************************************************************/
function UserRow({ user, roles = [], departments = [], isCurrentUser = false, canManage = false, busy = false, onRoleChange, onStatusChange, onDepartmentChange }) {
  const suspended = String(user.status).toLowerCase() === "suspended";
  return (
    <div className="grid gap-3 border-b border-gray-100 p-4 last:border-0 dark:border-gray-800 lg:grid-cols-[1.2fr_0.7fr_0.7fr_1.4fr] lg:items-center">
      <div className="flex items-center gap-3">
        <UserAvatar initials={user.initials} />
        <div>
          <p className="font-bold text-gray-950 dark:text-white">{user.name}</p>
          <p className="text-xs text-gray-500">{user.email}</p>
        </div>
      </div>
      <UserBadge>{user.role}</UserBadge>
      <span className="text-sm font-semibold text-gray-600 dark:text-gray-300">{user.status}</span>
      <div className="flex flex-wrap items-center gap-2">
        {canManage ? (
          <>
            <Select
              aria-label={`Role for ${user.name}`}
              className="max-w-48"
              value={user.roleId || ""}
              disabled={busy || isCurrentUser}
              onChange={(event) => onRoleChange?.(user.id, event.target.value)}
            >
              {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
            </Select>
            <Select
              aria-label={`Department for ${user.name}`}
              className="max-w-48"
              value={user.departmentId || ""}
              disabled={busy}
              onChange={(event) => onDepartmentChange?.(user.id, event.target.value)}
            >
              <option value="">No department</option>
              {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
            </Select>
            <Button
              variant="secondary"
              disabled={busy || isCurrentUser}
              onClick={() => onStatusChange?.(user.id, suspended ? "active" : "suspended")}
            >
              {busy ? "Saving..." : suspended ? "Reactivate" : "Suspend"}
            </Button>
          </>
        ) : null}
        {isCurrentUser ? <span className="text-xs font-semibold text-gray-500">Current account</span> : null}
      </div>
    </div>
  );
}

export default UserRow;
