import Card from "../shared/ui/Card";
import UserRow from "./UserRow";

function UserTable({ users = [] }) {
  return <Card><h2 className="section-title">Team Directory</h2><div className="mt-5 overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-800">{users.length === 0 ? <p className="p-5 text-sm text-gray-500">No users found.</p> : users.map((user) => <UserRow key={user.id} user={user} />)}</div></Card>;
}

export default UserTable;
