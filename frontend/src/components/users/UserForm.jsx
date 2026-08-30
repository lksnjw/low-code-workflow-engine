import { useState } from "react";
import Button from "../shared/ui/Button";
import Input from "../shared/ui/Input";
import Select from "../shared/ui/Select";
import { userService } from "../../services/user.service";
import { apiErrorMessage } from "../../services/api";
import { useNotifications } from "../../context/NotificationContext";

/*******************************************************************************
 * Function: UserForm
 *
 * Performs the User Form operation on form for the UserForm module.
 ******************************************************************************/
function UserForm({ roles = [], departments = [], onCreated }) {
  const emptyForm = { name: "", email: "", password: "", roleId: "role_builder", departmentId: "" };
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const { notify } = useNotifications();
  const assignableRoles = roles;
/*******************************************************************************
 * Function: change
 *
 * Performs the change operation on the application for the UserForm module.
 ******************************************************************************/
  const change = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
/*******************************************************************************
 * Function: submit
 *
 * Performs the submit operation on the application for the UserForm module.
 ******************************************************************************/
  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = { ...form };
      if (!payload.departmentId) delete payload.departmentId;
      await userService.create(payload);
      setForm(emptyForm);
      notify("User created.", "success");
      await onCreated?.();
    } catch (error) {
      notify(apiErrorMessage(error, "Could not create user."), "error");
    } finally {
      setSaving(false);
    }
  };
  return <form className="space-y-3" onSubmit={submit}><Input value={form.name} onChange={change("name")} placeholder="Full name" required /><Input type="email" value={form.email} onChange={change("email")} placeholder="Email address" required /><Input type="password" value={form.password} onChange={change("password")} placeholder="Temporary password (8+ characters)" minLength={8} required /><Select aria-label="Role" value={form.roleId} onChange={change("roleId")}>{assignableRoles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</Select><Select aria-label="Department" value={form.departmentId} onChange={change("departmentId")}><option value="">No department</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</Select><Button type="submit" disabled={saving || assignableRoles.length === 0}>{saving ? "Creating..." : "Create User"}</Button></form>;
}

export default UserForm;
