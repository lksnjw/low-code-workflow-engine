import Card from "../shared/ui/Card";
import UserRow from "./UserRow";

/*******************************************************************************
 * Function: UserTable
 *
 * Performs the User Table operation on table for the UserTable module.
 ******************************************************************************/
function UserTable({ users = [], roles = [], departments = [], currentUserId, canManage = false, busyUserId, onRoleChange, onStatusChange, onDepartmentChange }) {
  return <Card><h2 className="section-title">Team Directory</h2><div className="mt-5 overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-800">{users.length === 0 ? <p className="p-5 text-sm text-gray-500">No users found.</p> : users.map((user) => <UserRow key={user.id} user={user} roles={roles} departments={departments} isCurrentUser={user.id === currentUserId} canManage={canManage} busy={busyUserId === user.id} onRoleChange={onRoleChange} onStatusChange={onStatusChange} onDepartmentChange={onDepartmentChange} />)}</div></Card>;
}

export default UserTable;
