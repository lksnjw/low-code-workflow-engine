import { useMemo, useState } from "react";
import { EmptyState, LoadingState } from "../shared/ResourceState";
import Button from "../shared/ui/Button";
import Card from "../shared/ui/Card";
import Checkbox from "../shared/ui/Checkbox";
import Modal from "../shared/ui/Modal";
import Select from "../shared/ui/Select";
import { apiErrorMessage } from "../../services/api";

const BUILT_IN_ROLE_IDS = new Set(["role_admin", "role_system_admin", "role_builder", "role_client"]);

/*******************************************************************************
 * Function: RolePermissionEditor
 *
 * Performs the Role Permission Editor operation on permission editor for the RolePermissionEditor module.
 ******************************************************************************/
function RolePermissionEditor({
  roles = [],
  permissions = [],
  canManage = false,
  saving = false,
  onSave,
  onDelete,
}) {
  const [roleId, setRoleId] = useState("");
  const [drafts, setDrafts] = useState({});
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
/*******************************************************************************
 * Function: role
 *
 * Performs the role operation on the application for the RolePermissionEditor module.
 ******************************************************************************/
  const role = useMemo(() => roles.find((item) => item.id === roleId) || roles[0], [roleId, roles]);
/*******************************************************************************
 * Function: availableKeys
 *
 * Performs the available Keys operation on keys for the RolePermissionEditor module.
 ******************************************************************************/
  const availableKeys = useMemo(() => new Set(permissions.map((permission) => permission.key)), [permissions]);
/*******************************************************************************
 * Function: selected
 *
 * Performs the selected operation on the application for the RolePermissionEditor module.
 ******************************************************************************/
  const selected = (role
    ? drafts[role.id] ?? (Array.isArray(role.permissions) ? role.permissions : [])
    : []).filter((permission) => availableKeys.has(permission));
  const builtIn = role ? BUILT_IN_ROLE_IDS.has(role.id) : false;

/*******************************************************************************
 * Function: toggle
 *
 * Performs the toggle operation on the application for the RolePermissionEditor module.
 ******************************************************************************/
  const toggle = (permissionKey) => {
    if (!role) return;
    setDrafts((current) => ({
      ...current,
      [role.id]: selected.includes(permissionKey)
        ? selected.filter((item) => item !== permissionKey)
        : [...selected, permissionKey],
    }));
  };

/*******************************************************************************
 * Function: closeDelete
 *
 * Performs the close Delete operation on delete for the RolePermissionEditor module.
 ******************************************************************************/
  const closeDelete = () => {
    if (deleting) return;
    setDeleteOpen(false);
    setDeleteError("");
  };

/*******************************************************************************
 * Function: confirmDelete
 *
 * Performs the confirm Delete operation on delete for the RolePermissionEditor module.
 ******************************************************************************/
  const confirmDelete = async () => {
    if (!role) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await onDelete?.(role.id);
      setDeleteOpen(false);
    } catch (error) {
      const holders = error?.response?.data?.meta?.holders;
      setDeleteError(Number.isInteger(holders)
        ? `This role is assigned to ${holders} user${holders === 1 ? "" : "s"} and cannot be deleted.`
        : apiErrorMessage(error, "Could not delete role."));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="section-title">Role Permission Editor</h2>
          <p className="mt-1 text-sm text-gray-500">Changes apply to every current holder on their next request.</p>
        </div>
        <Select aria-label="Role to edit" value={role?.id || ""} onChange={(event) => setRoleId(event.target.value)}>
          {roles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
      </div>
      {role ? (
        <>
          {permissions.length === 0 ? (
            <div className="mt-5">
              <EmptyState title="No permissions available" description="This role can be saved with zero permissions." />
            </div>
          ) : (
            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {permissions.map((permission) => (
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
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-xs text-gray-500">{selected.length} permission{selected.length === 1 ? "" : "s"} selected; zero is valid.</span>
            <div className="flex flex-wrap gap-2">
              <span title={builtIn ? "Built-in roles cannot be deleted" : ""}>
                <Button
                  variant="secondary"
                  disabled={!canManage || saving || builtIn}
                  onClick={() => setDeleteOpen(true)}
                >
                  Delete role
                </Button>
              </span>
              <Button disabled={!canManage || saving} onClick={() => onSave?.(role.id, selected)}>
                {saving ? "Saving..." : "Save Permissions"}
              </Button>
            </div>
          </div>
        </>
      ) : (
        <div className="mt-5">
          <EmptyState title="No roles configured" description="Create a role to begin managing permissions." />
        </div>
      )}
      <Modal open={deleteOpen} title={role ? `Delete ${role.name}?` : "Delete role?"}>
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            This permanently deletes the role. Roles assigned to users cannot be deleted.
          </p>
          {deleting ? <LoadingState label={`Deleting ${role?.name || "role"}...`} /> : null}
          {deleteError ? (
            <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300">
              <p className="font-bold">Role deletion failed</p>
              <p className="mt-1">{deleteError}</p>
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={deleting} onClick={closeDelete}>Cancel</Button>
            <Button disabled={deleting} onClick={confirmDelete}>
              {deleting ? "Deleting role..." : "Delete role"}
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

export default RolePermissionEditor;
