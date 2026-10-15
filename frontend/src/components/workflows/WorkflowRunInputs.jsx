import { useState } from "react";
import { runInputLabel } from "./workflowRunInput";

const control = "mt-1 w-full rounded-lg border border-gray-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-gray-600";
function JsonInput({ label, value, onChange, onError, disabled }) {
  const [text, setText] = useState(() => value === undefined ? "" : JSON.stringify(value, null, 2));
  return <label className="block text-sm font-medium">{label}<textarea aria-label={label} className={`${control} min-h-24 font-mono text-xs`} disabled={disabled} value={text} onChange={event => {
    const next = event.target.value; setText(next);
    if (!next.trim()) { onError(""); onChange(undefined); return; }
    try { const parsed = JSON.parse(next); onError(""); onChange(parsed); } catch { onError(`${label} is not valid JSON.`); }
  }} /></label>;
}
export default function WorkflowRunInputs({ schema, value = {}, onChange, onError, disabled, path = "", depth = 0 }) {
  if (!schema || schema.type !== "object" || depth > 8) return <JsonInput label={path || "Runtime input (JSON)"} value={value} onChange={next => onChange(next === undefined ? {} : next)} onError={error => onError(path || "input", error)} disabled={disabled} />;
  const fields = Object.entries(schema.properties || {});
  const change = (key, next) => { const updated = { ...value }; if (next === undefined) delete updated[key]; else updated[key] = next; onChange(updated); };
  if (!fields.length) return <p className="text-sm text-gray-500">No input fields are declared for this workflow.</p>;
  return <div className="space-y-4">{fields.slice(0, 50).map(([key, field]) => {
    const label = `${path ? path + " · " : ""}${runInputLabel(key, field)}`, supplied = value?.[key], required = schema.required?.includes(key);
    return <div key={key} className="space-y-1">
      <p className="text-sm font-medium">{label} <span className="text-xs text-gray-500">{required ? "Required" : "Optional"}</span></p>
      {field.description && <p className="text-xs leading-5 text-gray-500">{String(field.description).slice(0, 600)}</p>}
      {field.type === "object" ? <div className="border-l border-gray-200 pl-3 dark:border-gray-700"><WorkflowRunInputs schema={field} value={supplied || {}} onChange={next => change(key, next)} onError={onError} disabled={disabled} path={label} depth={depth + 1} /></div>
        : Array.isArray(field.enum) ? <select aria-label={label} aria-required={required} className={control} disabled={disabled} value={supplied === undefined ? "" : String(field.enum.findIndex(item => Object.is(item, supplied)))} onChange={event => change(key, event.target.value === "" ? undefined : field.enum[Number(event.target.value)])}><option value="">Choose…</option>{field.enum.map((option, index) => <option key={index} value={index}>{String(option)}</option>)}</select>
        : field.type === "boolean" ? <select aria-label={label} aria-required={required} className={control} disabled={disabled} value={supplied === undefined ? "" : String(supplied)} onChange={event => change(key, event.target.value === "" ? undefined : event.target.value === "true")}><option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option></select>
        : ["string", "number", "integer"].includes(field.type) ? <input aria-label={label} aria-required={required} type={field.writeOnly ? "password" : ["number", "integer"].includes(field.type) ? "number" : ["date", "email"].includes(field.format) ? field.format : "text"} autoComplete="off" step={field.type === "integer" ? "1" : "any"} className={control} disabled={disabled} value={supplied ?? ""} onChange={event => change(key, event.target.value === "" ? undefined : field.type === "string" ? event.target.value : event.target.valueAsNumber)} />
        : <JsonInput label={label} value={supplied} disabled={disabled} onChange={next => change(key, next)} onError={error => onError(label, error)} />}
    </div>;
  })}{fields.length > 50 && <p role="alert" className="text-xs text-amber-700">More than 50 input fields are declared. Review the workflow before running.</p>}</div>;
}
