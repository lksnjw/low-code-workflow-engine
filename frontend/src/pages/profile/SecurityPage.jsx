import Card from "../../components/shared/ui/Card";
import { useAuthContext } from "../../context/AuthContext";

function SecurityPage() {
  const { user } = useAuthContext();
  const facts = [
    ["Account status", user?.status || "Unknown"],
    ["Email verified", user?.emailVerified ? "Verified" : "Not verified"],
    ["Two-factor authentication", user?.twoFactorEnabled ? "Enabled" : "Not enabled"],
    ["Assigned role", user?.role || "No role assigned"],
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-heading text-gray-950 dark:text-white">Security</h1>
        <p className="mt-3 text-sm leading-6 text-gray-500 dark:text-gray-400">
          Current security facts returned by the authenticated user endpoint.
        </p>
      </div>
      <Card>
        <dl className="divide-y divide-gray-100 dark:divide-gray-800">
          {facts.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-4 py-4">
              <dt className="text-sm text-gray-500">{label}</dt>
              <dd className="text-sm font-semibold text-gray-950 dark:text-white">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-5 rounded-xl bg-backgroundLight p-4 text-sm text-gray-600 dark:bg-darkBackgroundVery dark:text-gray-300">
          Password recovery, email verification, and two-factor changes are unavailable because the backend reports those operations as not configured.
        </p>
      </Card>
    </div>
  );
}

export default SecurityPage;
