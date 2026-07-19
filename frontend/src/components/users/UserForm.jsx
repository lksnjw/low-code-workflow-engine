import { useState } from "react";
import Button from "../shared/ui/Button";
import Input from "../shared/ui/Input";
import Select from "../shared/ui/Select";
import { userService } from "../../services/user.service";
import { apiErrorMessage } from "../../services/api";
import { useNotifications } from "../../context/NotificationContext";

function UserForm({ roles = [], onCreated }) {
  const [form, setForm] = useState({ name: "", email: "", password: "", roleId: "role_builder" });
  const [saving, setSaving] = useState(false);
  const { notify } = useNotifications();
  const change = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      await userService.create(form);
      setForm({ name: "", email: "", password: "", roleId: "role_builder" });
      notify("User created.", "success");
      await onCreated?.();
    } catch (error) {
      notify(apiErrorMessage(error, "Could not create user."), "error");
    } finally {
      setSaving(false);
    }
  };
  return <form className="space-y-3" onSubmit={submit}><Input value={form.name} onChange={change("name")} placeholder="Full name" required /><Input type="email" value={form.email} onChange={change("email")} placeholder="Email address" required /><Input type="password" value={form.password} onChange={change("password")} placeholder="Temporary password (8+ characters)" minLength={8} required /><Select value={form.roleId} onChange={change("roleId")}>{roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</Select><Button disabled={saving}>{saving ? "Creating…" : "Create User"}</Button></form>;
}

export default UserForm;
