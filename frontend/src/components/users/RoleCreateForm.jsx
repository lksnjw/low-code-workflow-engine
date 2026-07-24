import { useMemo, useState } from "react";
import { EmptyState, LoadingState } from "../shared/ResourceState";
import Button from "../shared/ui/Button";
import Card from "../shared/ui/Card";
import Checkbox from "../shared/ui/Checkbox";
import Input from "../shared/ui/Input";
import { apiErrorMessage } from "../../services/api";

export function restrictPermissionsToCaller(permissions = [], callerPermissions = []) {
  const held = new Set(callerPermissions);
  return permissions.filter((permission) => held.has(permission.key));
}

function RoleCreateForm({
  permissions = [],
  callerPermissions = [],
  canManage = false,
  onCreate,
}) {
  const availablePermissions = useMemo(
    () => restrictPermissionsToCaller(permissions, callerPermissions),
    [permissions, callerPermissions]
  );
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState([]);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const toggle = (permission) => {
    setSelected((current) => current.includes(permission)
      ? current.filter((item) => item !== permission)
      : [...current, permission]);
  };

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setErrorMessage("");
    try {
      await onCreate?.({ name, description, permissions: selected });
      setName("");
      setDescription("");
      setSelected([]);
    } catch (error) {
      setErrorMessage(apiErrorMessage(error, "Could not create role."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <h2 className="section-title">Create role</h2>
      <p className="mt-1 text-sm text-gray-500">
        Only permissions held by your current account can be granted.
      </p>
      <form className="mt-5 space-y-4" onSubmit={submit}>
        <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200">
          Role name
          <Input className="mt-2" value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200">
          Description
          <Input className="mt-2" value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        {availablePermissions.length === 0 ? (
          <EmptyState
            title="No permissions available to grant"
            description="You can still create a role with zero permissions."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {availablePermissions.map((permission) => (
              <div key={permission.key} className="rounded-xl border border-gray-200 p-3 dark:border-gray-800">
                <Checkbox
                  label={permission.name}
                  checked={selected.includes(permission.key)}
                  disabled={!canManage || saving}
                  onChange={() => toggle(permission.key)}
                />
                <p className="mt-1 text-xs leading-5 text-gray-500">{permission.description}</p>
              </div>
            ))}
          </div>
        )}
        {saving ? <LoadingState label="Creating role..." /> : null}
        {errorMessage ? (
          <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300">
            <p className="font-bold">Role creation failed</p>
            <p className="mt-1">{errorMessage}</p>
          </div>
        ) : null}
        <Button type="submit" disabled={!canManage || saving || !name.trim()}>
          {saving ? "Creating role..." : "Create role"}
        </Button>
      </form>
    </Card>
  );
}

export default RoleCreateForm;
