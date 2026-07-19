import UserAvatar from "./UserAvatar";
import UserBadge from "./UserBadge";

function UserRow({ user }) {
  return (
    <div className="grid gap-3 border-b border-gray-100 p-4 last:border-0 dark:border-gray-800 md:grid-cols-[1.2fr_0.8fr_0.6fr]">
      <div className="flex items-center gap-3">
        <UserAvatar initials={user.initials} />
        <div>
          <p className="font-bold text-gray-950 dark:text-white">{user.name}</p>
          <p className="text-xs text-gray-500">{user.email}</p>
        </div>
      </div>
      <UserBadge>{user.role}</UserBadge>
      <span className="text-sm font-semibold text-gray-600 dark:text-gray-300">{user.status}</span>
    </div>
  );
}

export default UserRow;
