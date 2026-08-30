import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import FormField from "../../components/shared/forms/FormField";
import { EmptyState, ErrorState, LoadingState } from "../../components/shared/ResourceState";
import Button from "../../components/shared/ui/Button";
import Card from "../../components/shared/ui/Card";
import Input from "../../components/shared/ui/Input";
import Tabs from "../../components/shared/ui/Tabs";
import Textarea from "../../components/shared/ui/Textarea";
import usePermissions from "../../hooks/usePermissions";
import { apiErrorMessage } from "../../services/api";
import { companyService } from "../../services/company.service";

const EMPTY_DEPARTMENT = { id: "", name: "", domains: "" };
const EMPTY_COST_CENTRE = { code: "", name: "", ownerUserId: "", budgetAmount: "", currency: "" };
const EMPTY_APPROVAL_TIER = { label: "", maxAmount: "", approverRoleId: "" };

const tabs = [
  { id: "general", label: "General" },
  { id: "departments", label: "Departments" },
  { id: "cost-centres", label: "Cost Centres" },
  { id: "approval-tiers", label: "Approval Tiers" },
];

/*******************************************************************************
 * Function: CompanyPage
 *
 * Performs the Company Page operation on page for the CompanyPage module.
 ******************************************************************************/
function CompanyPage() {
  const { roleId } = usePermissions();
  const canEdit = roleId === "role_admin" || roleId === "role_system_admin";
  const [activeTab, setActiveTab] = useState("general");
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["company"], queryFn: companyService.get });
  const profile = query.data;

  if (query.isLoading) return <LoadingState label="Loading company profile…" />;
  if (query.error) return <ErrorState onRetry={query.refetch} />;
  if (!profile) return <EmptyState title="No company profile" description="The company profile record is unavailable." />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-heading text-gray-950 dark:text-white">Company</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">
          Company and ERP context used to organize departments, cost ownership, approval tiers, and workflow relevance.
        </p>
        {!canEdit ? <p className="mt-2 text-xs font-semibold text-gray-500">Read-only for your role.</p> : null}
      </div>
      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
      {activeTab === "general" ? (
        <GeneralTab profile={profile} canEdit={canEdit} onSaved={(saved) => queryClient.setQueryData(["company"], saved)} />
      ) : null}
      {activeTab === "departments" ? (
        <DepartmentsTab profile={profile} canEdit={canEdit} onChanged={query.refetch} />
      ) : null}
      {activeTab === "cost-centres" ? (
        <CostCentresTab profile={profile} canEdit={canEdit} onChanged={query.refetch} />
      ) : null}
      {activeTab === "approval-tiers" ? (
        <ApprovalTiersTab profile={profile} canEdit={canEdit} onChanged={query.refetch} />
      ) : null}
    </div>
  );
}

/*******************************************************************************
 * Function: GeneralTab
 *
 * Performs the General Tab operation on tab for the CompanyPage module.
 ******************************************************************************/
function GeneralTab({ profile, canEdit, onSaved }) {
  const [form, setForm] = useState(profile);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
/*******************************************************************************
 * Function: change
 *
 * Performs the change operation on the application for the CompanyPage module.
 ******************************************************************************/
  const change = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

/*******************************************************************************
 * Function: submit
 *
 * Performs the submit operation on the application for the CompanyPage module.
 ******************************************************************************/
  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setFieldErrors({});
    setMessage("");
    setFailed(false);
    try {
      const saved = await companyService.update(form);
      setForm(saved);
      onSaved(saved);
      setMessage("Company profile saved.");
    } catch (error) {
      setFieldErrors(validationErrors(error));
      setMessage(apiErrorMessage(error, "Could not save the company profile."));
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const fields = [
    ["name", "Company name"],
    ["legalName", "Legal name"],
    ["industry", "Industry"],
    ["timezone", "IANA timezone"],
    ["currency", "Currency"],
    ["fiscalYearStart", "Fiscal year start"],
    ["contactEmail", "Contact email"],
    ["erpSystemName", "ERP system name"],
    ["erpVersion", "ERP version"],
  ];
  return (
    <Card>
      <form className="space-y-5" onSubmit={submit}>
        <div className="grid gap-4 md:grid-cols-2">
          {fields.map(([key, label]) => (
            <FormField key={key} label={label} error={fieldErrors[key]}>
              <Input value={form[key] || ""} onChange={change(key)} disabled={!canEdit || saving} />
            </FormField>
          ))}
        </div>
        <FormField label="Notes" error={fieldErrors.notes}>
          <Textarea value={form.notes || ""} onChange={change("notes")} disabled={!canEdit || saving} />
        </FormField>
        {message ? <InlineMessage message={message} error={failed} /> : null}
        {canEdit ? <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save company profile"}</Button> : null}
      </form>
    </Card>
  );
}

/*******************************************************************************
 * Function: DepartmentsTab
 *
 * Performs the Departments Tab operation on tab for the CompanyPage module.
 ******************************************************************************/
function DepartmentsTab({ profile, canEdit, onChanged }) {
  const [form, setForm] = useState(EMPTY_DEPARTMENT);
  const [editingID, setEditingID] = useState("");
  const mutation = useInlineMutation();
  const departments = profile.departments || [];
/*******************************************************************************
 * Function: edit
 *
 * Performs the edit operation on the application for the CompanyPage module.
 ******************************************************************************/
  const edit = (department) => {
    setEditingID(department.id);
    setForm({ ...department, domains: (department.domains || []).join(", ") });
    mutation.clear();
  };
/*******************************************************************************
 * Function: save
 *
 * Saves the application for the CompanyPage module.
 ******************************************************************************/
  const save = async (event) => {
    event.preventDefault();
    const payload = { ...form, domains: splitDomains(form.domains) };
/*******************************************************************************
 * Function: result
 *
 * Performs the result operation on the application for the CompanyPage module.
 ******************************************************************************/
    const result = await mutation.run(() => editingID
      ? companyService.updateDepartment(editingID, payload)
      : companyService.createDepartment(payload));
    if (result) {
      setForm(EMPTY_DEPARTMENT);
      setEditingID("");
      await onChanged();
    }
  };
/*******************************************************************************
 * Function: remove
 *
 * Removes the application for the CompanyPage module.
 ******************************************************************************/
  const remove = async (id) => {
    if (await mutation.run(() => companyService.deleteDepartment(id))) {
      await onChanged();
    }
  };
  return (
    <ResourceEditor
      title="Departments"
      empty={departments.length === 0}
      emptyTitle="No departments"
      emptyDescription="Departments connect users with runtime registry namespaces."
      list={departments.map((department) => (
        <ResourceRow key={department.id} title={department.name || department.id} detail={(department.domains || []).join(", ") || "No domains"} canEdit={canEdit} onEdit={() => edit(department)} onDelete={() => remove(department.id)} />
      ))}
      form={canEdit ? (
        <form className="grid gap-4 md:grid-cols-3" onSubmit={save}>
          <FormField label="Department ID" error={matchingError(mutation.fieldErrors, "departments", "id")}>
            <Input value={form.id} disabled={Boolean(editingID) || mutation.busy} onChange={(event) => setForm({ ...form, id: event.target.value })} required />
          </FormField>
          <FormField label="Name">
            <Input value={form.name} disabled={mutation.busy} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </FormField>
          <FormField label="Registry domains" error={matchingError(mutation.fieldErrors, "departments", "domains")}>
            <Input value={form.domains} disabled={mutation.busy} onChange={(event) => setForm({ ...form, domains: event.target.value })} placeholder="finance, procurement" />
          </FormField>
          <EditorActions editing={Boolean(editingID)} busy={mutation.busy} onCancel={() => { setEditingID(""); setForm(EMPTY_DEPARTMENT); mutation.clear(); }} />
        </form>
      ) : null}
      message={mutation.message}
      error={mutation.error}
    />
  );
}

/*******************************************************************************
 * Function: CostCentresTab
 *
 * Performs the Cost Centres Tab operation on centres tab for the CompanyPage module.
 ******************************************************************************/
function CostCentresTab({ profile, canEdit, onChanged }) {
  const [form, setForm] = useState(EMPTY_COST_CENTRE);
  const [editingCode, setEditingCode] = useState("");
  const mutation = useInlineMutation();
  const items = profile.costCentres || [];
/*******************************************************************************
 * Function: edit
 *
 * Performs the edit operation on the application for the CompanyPage module.
 ******************************************************************************/
  const edit = (item) => {
    setEditingCode(item.code);
    setForm({ ...item, budgetAmount: String(item.budgetAmount ?? "") });
    mutation.clear();
  };
/*******************************************************************************
 * Function: save
 *
 * Saves the application for the CompanyPage module.
 ******************************************************************************/
  const save = async (event) => {
    event.preventDefault();
    const payload = { ...form, budgetAmount: Number(form.budgetAmount) };
/*******************************************************************************
 * Function: result
 *
 * Performs the result operation on the application for the CompanyPage module.
 ******************************************************************************/
    const result = await mutation.run(() => editingCode
      ? companyService.updateCostCentre(editingCode, payload)
      : companyService.createCostCentre(payload));
    if (result) {
      setForm(EMPTY_COST_CENTRE);
      setEditingCode("");
      await onChanged();
    }
  };
/*******************************************************************************
 * Function: remove
 *
 * Removes the application for the CompanyPage module.
 ******************************************************************************/
  const remove = async (code) => {
    if (await mutation.run(() => companyService.deleteCostCentre(code))) await onChanged();
  };
  return (
    <ResourceEditor
      title="Cost Centres"
      empty={items.length === 0}
      emptyTitle="No cost centres"
      emptyDescription="Add cost ownership and budgets when they are available."
      list={items.map((item) => (
        <ResourceRow key={item.code} title={`${item.code} · ${item.name}`} detail={`${item.currency} ${Number(item.budgetAmount || 0).toLocaleString()}`} canEdit={canEdit} onEdit={() => edit(item)} onDelete={() => remove(item.code)} />
      ))}
      form={canEdit ? (
        <form className="grid gap-4 md:grid-cols-3" onSubmit={save}>
          {[
            ["code", "Code"], ["name", "Name"], ["ownerUserId", "Owner user ID"],
            ["budgetAmount", "Budget amount"], ["currency", "Currency"],
          ].map(([key, label]) => (
            <FormField key={key} label={label} error={matchingError(mutation.fieldErrors, "costCentres", key)}>
              <Input type={key === "budgetAmount" ? "number" : "text"} min={key === "budgetAmount" ? 0 : undefined} value={form[key]} disabled={mutation.busy || (key === "code" && Boolean(editingCode))} onChange={(event) => setForm({ ...form, [key]: event.target.value })} required={key === "code" || key === "currency"} />
            </FormField>
          ))}
          <EditorActions editing={Boolean(editingCode)} busy={mutation.busy} onCancel={() => { setEditingCode(""); setForm(EMPTY_COST_CENTRE); mutation.clear(); }} />
        </form>
      ) : null}
      message={mutation.message}
      error={mutation.error}
    />
  );
}

/*******************************************************************************
 * Function: ApprovalTiersTab
 *
 * Performs the Approval Tiers Tab operation on tiers tab for the CompanyPage module.
 ******************************************************************************/
function ApprovalTiersTab({ profile, canEdit, onChanged }) {
  const [form, setForm] = useState(EMPTY_APPROVAL_TIER);
  const [editingLabel, setEditingLabel] = useState("");
  const mutation = useInlineMutation();
  const items = profile.approvalTiers || [];
/*******************************************************************************
 * Function: edit
 *
 * Performs the edit operation on the application for the CompanyPage module.
 ******************************************************************************/
  const edit = (item) => {
    setEditingLabel(item.label);
    setForm({ ...item, maxAmount: String(item.maxAmount ?? "") });
    mutation.clear();
  };
/*******************************************************************************
 * Function: save
 *
 * Saves the application for the CompanyPage module.
 ******************************************************************************/
  const save = async (event) => {
    event.preventDefault();
    const payload = { ...form, maxAmount: Number(form.maxAmount) };
/*******************************************************************************
 * Function: result
 *
 * Performs the result operation on the application for the CompanyPage module.
 ******************************************************************************/
    const result = await mutation.run(() => editingLabel
      ? companyService.updateApprovalTier(editingLabel, payload)
      : companyService.createApprovalTier(payload));
    if (result) {
      setForm(EMPTY_APPROVAL_TIER);
      setEditingLabel("");
      await onChanged();
    }
  };
/*******************************************************************************
 * Function: remove
 *
 * Removes the application for the CompanyPage module.
 ******************************************************************************/
  const remove = async (label) => {
    if (await mutation.run(() => companyService.deleteApprovalTier(label))) await onChanged();
  };
  return (
    <ResourceEditor
      title="Approval Tiers"
      empty={items.length === 0}
      emptyTitle="No approval tiers"
      emptyDescription="Approval tiers must be ordered by strictly increasing maximum amount."
      list={items.map((item) => (
        <ResourceRow key={item.label} title={item.label} detail={`Up to ${Number(item.maxAmount || 0).toLocaleString()} · ${item.approverRoleId}`} canEdit={canEdit} onEdit={() => edit(item)} onDelete={() => remove(item.label)} />
      ))}
      form={canEdit ? (
        <form className="grid gap-4 md:grid-cols-3" onSubmit={save}>
          {[
            ["label", "Label"], ["maxAmount", "Maximum amount"], ["approverRoleId", "Approver role ID"],
          ].map(([key, label]) => (
            <FormField key={key} label={label} error={matchingError(mutation.fieldErrors, "approvalTiers", key)}>
              <Input type={key === "maxAmount" ? "number" : "text"} min={key === "maxAmount" ? 0 : undefined} value={form[key]} disabled={mutation.busy} onChange={(event) => setForm({ ...form, [key]: event.target.value })} required />
            </FormField>
          ))}
          <EditorActions editing={Boolean(editingLabel)} busy={mutation.busy} onCancel={() => { setEditingLabel(""); setForm(EMPTY_APPROVAL_TIER); mutation.clear(); }} />
        </form>
      ) : null}
      message={mutation.message}
      error={mutation.error}
    />
  );
}

/*******************************************************************************
 * Function: ResourceEditor
 *
 * Performs the Resource Editor operation on editor for the CompanyPage module.
 ******************************************************************************/
function ResourceEditor({ title, empty, emptyTitle, emptyDescription, list, form, message, error }) {
  return (
    <div className="space-y-4">
      <Card>
        <h2 className="section-title">{title}</h2>
        <div className="mt-4 space-y-3">
          {empty ? <EmptyState title={emptyTitle} description={emptyDescription} /> : list}
        </div>
      </Card>
      {form ? <Card>{form}</Card> : null}
      {message ? <InlineMessage message={message} error={error} /> : null}
    </div>
  );
}

/*******************************************************************************
 * Function: ResourceRow
 *
 * Performs the Resource Row operation on row for the CompanyPage module.
 ******************************************************************************/
function ResourceRow({ title, detail, canEdit, onEdit, onDelete }) {
  return (
    <div className="flex flex-col justify-between gap-3 rounded-xl border border-gray-200 p-4 dark:border-gray-800 sm:flex-row sm:items-center">
      <div><p className="font-bold text-gray-950 dark:text-white">{title}</p><p className="mt-1 text-sm text-gray-500">{detail}</p></div>
      {canEdit ? <div className="flex gap-2"><Button variant="secondary" onClick={onEdit}>Edit</Button><Button variant="ghost" onClick={onDelete}>Delete</Button></div> : null}
    </div>
  );
}

/*******************************************************************************
 * Function: EditorActions
 *
 * Performs the Editor Actions operation on actions for the CompanyPage module.
 ******************************************************************************/
function EditorActions({ editing, busy, onCancel }) {
  return (
    <div className="flex items-end gap-2 md:col-span-3">
      <Button type="submit" disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : "Add"}</Button>
      {editing ? <Button variant="secondary" onClick={onCancel}>Cancel</Button> : null}
    </div>
  );
}

/*******************************************************************************
 * Function: InlineMessage
 *
 * Performs the Inline Message operation on message for the CompanyPage module.
 ******************************************************************************/
function InlineMessage({ message, error }) {
  return <p className={`text-sm font-semibold ${error ? "text-red-600 dark:text-red-300" : "text-emerald-700 dark:text-emerald-300"}`}>{message}</p>;
}

/*******************************************************************************
 * Function: useInlineMutation
 *
 * Provides inline mutation for the CompanyPage module.
 ******************************************************************************/
function useInlineMutation() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState(false);
  return useMemo(() => ({
    busy,
    message,
    fieldErrors,
    error,
    clear: () => { setMessage(""); setFieldErrors({}); setError(false); },
    run: async (operation) => {
      setBusy(true);
      setMessage("");
      setFieldErrors({});
      setError(false);
      try {
        const result = await operation();
        setMessage("Changes saved.");
        return result;
      } catch (requestError) {
        setFieldErrors(validationErrors(requestError));
        setMessage(apiErrorMessage(requestError, "The change could not be saved."));
        setError(true);
        return null;
      } finally {
        setBusy(false);
      }
    },
  }), [busy, message, fieldErrors, error]);
}

/*******************************************************************************
 * Function: validationErrors
 *
 * Performs the validation Errors operation on errors for the CompanyPage module.
 ******************************************************************************/
function validationErrors(error) {
  return error?.response?.data?.data?.fieldErrors || {};
}

/*******************************************************************************
 * Function: matchingError
 *
 * Performs the matching Error operation on error for the CompanyPage module.
 ******************************************************************************/
function matchingError(errors, section, field) {
/*******************************************************************************
 * Function: entry
 *
 * Performs the entry operation on the application for the CompanyPage module.
 ******************************************************************************/
  const entry = Object.entries(errors || {}).find(([key]) => key.startsWith(`${section}.`) && key.endsWith(`.${field}`));
  return entry?.[1] || "";
}

/*******************************************************************************
 * Function: splitDomains
 *
 * Performs the split Domains operation on domains for the CompanyPage module.
 ******************************************************************************/
function splitDomains(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

export default CompanyPage;
