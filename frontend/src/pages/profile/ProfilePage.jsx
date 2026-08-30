import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Card from "../../components/shared/ui/Card";
import Avatar from "../../components/shared/ui/Avatar";
import Button from "../../components/shared/ui/Button";
import Input from "../../components/shared/ui/Input";
import { ErrorState, LoadingState } from "../../components/shared/ResourceState";
import { useAuthContext } from "../../context/AuthContext";
import { profileService } from "../../services/profile.service";

/*******************************************************************************
 * Function: initials
 *
 * Performs the initials operation on the application for the ProfilePage module.
 ******************************************************************************/
function initials(name = "") {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

/*******************************************************************************
 * Function: ProfilePage
 *
 * Performs the Profile Page operation on page for the ProfilePage module.
 ******************************************************************************/
function ProfilePage() {
  const queryClient = useQueryClient();
  const { refreshUser } = useAuthContext();
  const profile = useQuery({ queryKey: ["profile"], queryFn: profileService.get });
/*******************************************************************************
 * Function: update
 *
 * Updates the application for the ProfilePage module.
 ******************************************************************************/
  const update = useMutation({
    mutationFn: profileService.update,
    onSuccess: async () => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["profile"] }), refreshUser()]);
    },
  });

  if (profile.isLoading) return <LoadingState label="Loading profile…" />;
  if (profile.error) return <ErrorState error={profile.error} onRetry={profile.refetch} />;
  const data = profile.data || {};

/*******************************************************************************
 * Function: submit
 *
 * Performs the submit operation on the application for the ProfilePage module.
 ******************************************************************************/
  const submit = (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    update.mutate({ name: form.get("name"), timezone: form.get("timezone") });
  };

  return (
    <form key={`${data.name}:${data.timezone}`} onSubmit={submit} className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
      <Card>
        <Avatar initials={initials(data.name)} className="h-16 w-16 text-lg" />
        <h1 className="mt-5 text-2xl font-bold text-gray-950 dark:text-white">{data.name}</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{data.role || "No role assigned"}</p>
        <Button type="submit" disabled={update.isPending} className="mt-6 w-full">
          {update.isPending ? "Saving…" : "Update Profile"}
        </Button>
        {update.isSuccess ? <p className="mt-3 text-sm text-emerald-600">Profile updated.</p> : null}
        {update.error ? <p className="mt-3 text-sm text-red-600">The profile could not be updated. Try again.</p> : null}
      </Card>
      <Card>
        <h2 className="section-title">Account Details</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <label className="text-xs font-semibold text-gray-500">Name<Input name="name" required defaultValue={data.name || ""} className="mt-2" /></label>
          <label className="text-xs font-semibold text-gray-500">Email<Input value={data.email || ""} readOnly className="mt-2 opacity-70" /></label>
          <label className="text-xs font-semibold text-gray-500">Timezone<Input name="timezone" required defaultValue={data.timezone || "UTC"} className="mt-2" /></label>
          <label className="text-xs font-semibold text-gray-500">Role<Input value={data.role || ""} readOnly className="mt-2 opacity-70" /></label>
        </div>
      </Card>
    </form>
  );
}

export default ProfilePage;
