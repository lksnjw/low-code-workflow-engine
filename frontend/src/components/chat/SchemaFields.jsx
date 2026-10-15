import ReadableValue from "./ReadableValue";
import ValueFields from "./ValueFields";

const control = "min-w-0 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackground";
const initial = (schema) => ({ string: "", number: 0, integer: 0, boolean: false, object: {}, array: [], null: null })[schema.type];
const shape = (schema, value) => schema.type === "null" ? value === null : schema.type === "array" ? Array.isArray(value) : schema.type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : schema.type === "integer" ? typeof value === "number" && Number.isInteger(value) : typeof value === schema.type;
const reference = (value) => typeof value === "string" && /^\s*\{\{[\s\S]*?\}\}\s*$/.test(value);
const compatible = (source, target, depth = 0) => {
  if (!source || !target || depth > 16 || source.writeOnly || target.writeOnly || source.type !== target.type && !(source.type === "integer" && target.type === "number")) return false;
  if (source.type === "array") return compatible(source.items, target.items, depth + 1);
  if (source.type === "object") {
    if ((target.required || []).some(key => !source.properties?.[key] && source.additionalProperties === false)) return false;
    return Object.entries(target.properties || {}).every(([key, child]) => !source.properties?.[key] || compatible(source.properties[key], child, depth + 1));
  }
  return true;
};

function Field({ schema, value, onChange, label, depth, dataSources, allowReferences }) {
  const fromData = allowReferences && reference(value), choices = allowReferences ? dataSources.filter(source => compatible(source.schema, schema)) : [];
  const known = choices.some(source => source.expression === value);
  if (schema.writeOnly && schema.type !== "string") return <p className="text-xs text-gray-500">Sensitive non-text value is preserved and hidden. Use a scoped proposal to change it.</p>;
  return <div className="space-y-2">
    {!schema.writeOnly && (choices.length > 0 || fromData) && <select aria-label={`${label} input mode`} className={control} value={fromData ? "data" : "literal"} onChange={event => onChange(event.target.value === "data" ? choices[0]?.expression ?? value : initial(schema))}><option value="literal">Enter value</option><option value="data" disabled={!choices.length && !fromData}>Use upstream data</option></select>}
    {fromData ? <>
      <select aria-label={`${label} data source`} className={`${control} w-full`} value={value} onChange={event => onChange(event.target.value)}>{!known && <option value={value}>Existing reference · needs validation</option>}{choices.map(source => <option key={source.expression} value={source.expression}>{source.label} · {source.schema.type}</option>)}</select>
      <p className="text-[10px] text-gray-500">{known ? "Reference selected · resolved at runtime, not a fetched answer." : "Reference preserved. Current scope or type could not be confirmed."}</p>
      {schema.writeOnly && <button type="button" className="text-xs text-primary" onClick={() => onChange(initial(schema))}>Replace with sensitive value</button>}
    </> : !shape(schema, value) ? <><p role="alert" className="text-xs text-amber-700">Existing value does not match {schema.type}. It is preserved until you explicitly replace it.</p><ReadableValue value={schema.writeOnly ? "Sensitive value hidden" : value} /><button type="button" className="text-xs text-primary" onClick={() => onChange(initial(schema))}>Replace {label} with {schema.type}</button></> : <>
      {schema.type === "string" && <input aria-label={label} type={schema.writeOnly ? "password" : "text"} autoComplete="off" className={`${control} w-full`} value={value} onChange={event => onChange(event.target.value)} />}
      {(schema.type === "number" || schema.type === "integer") && <input aria-label={label} type="number" step={schema.type === "integer" ? "1" : "any"} className={`${control} w-full`} value={value} onChange={event => { const next = event.target.valueAsNumber; if (Number.isFinite(next) && (schema.type !== "integer" || Number.isInteger(next))) onChange(next); }} />}
      {schema.type === "boolean" && <select aria-label={label} className={`${control} w-full`} value={String(value)} onChange={event => onChange(event.target.value === "true")}><option value="false">No</option><option value="true">Yes</option></select>}
      {schema.type === "null" && <p className="text-xs text-gray-500">Explicit null</p>}
      {(schema.type === "object" || schema.type === "array") && <SchemaFields schema={schema} value={value} onChange={onChange} label={label} depth={depth + 1} dataSources={schema.writeOnly ? [] : dataSources} allowReferences={allowReferences && !schema.writeOnly} />}
    </>}
  </div>;
}

// Form guidance only. Saving still goes through revisioned commands; live
// authority and exact concrete input validation remain on the backend.
export default function SchemaFields({ schema, value, onChange, label = "Parameters", depth = 0, dataSources = [], allowReferences = true }) {
  if (schema?.writeOnly && schema.type !== "string") return <p className="text-xs text-gray-500">Sensitive non-text value is preserved and hidden. Use a scoped proposal to change it.</p>;
  if (!schema || depth > 8) return <p className="text-xs text-gray-500">Schema guidance unavailable at this depth. Existing values are preserved; use a scoped proposal to edit them.</p>;
  if (schema.type === "array" && Array.isArray(value)) return <div className="space-y-3 border-l border-gray-200 pl-3 dark:border-gray-700">
    {value.slice(0, 50).map((item, index) => <div key={index} className="space-y-2"><Field schema={schema.items} value={item} label={`${label} · Item ${index + 1}`} depth={depth} dataSources={dataSources} allowReferences={allowReferences} onChange={next => onChange(value.map((old, position) => position === index ? next : old))} /><button type="button" className="text-[10px] text-gray-500" onClick={() => onChange(value.filter((_, position) => position !== index))}>Remove item {index + 1}</button></div>)}
    {value.length > 50 && <p className="text-xs text-gray-500">Additional items are preserved; use a scoped proposal to edit them.</p>}
    <button type="button" className="text-xs text-primary" disabled={value.length >= 50} onClick={() => onChange([...value, initial(schema.items)])}>Add item to {label}</button>
  </div>;
  if (schema.type !== "object" || !shape(schema, value)) return <Field schema={schema} value={value} onChange={onChange} label={label} depth={depth} dataSources={dataSources} allowReferences={allowReferences} />;
  const properties = schema.properties || {}, required = schema.required || [], keys = [...new Set([...Object.keys(properties), ...required])];
  const extras = Object.fromEntries(Object.entries(value).filter(([key]) => !Object.hasOwn(properties, key)));
  return <div aria-label={`${label} schema fields`} className="space-y-4 border-l border-gray-200 pl-3 dark:border-gray-700">
    {keys.slice(0, 50).map(key => {
      const child = properties[key], present = Object.hasOwn(value, key), name = `${label} · ${key}`;
      return <div key={key} className="space-y-2"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="break-all text-xs font-medium">{key}</span><span className="text-[10px] text-gray-500">{child?.type || "Undeclared type"} · {required.includes(key) ? "Required" : "Optional"}{child?.writeOnly ? " · Sensitive" : ""}</span></div>
        {typeof child?.description === "string" && <p className="whitespace-pre-wrap break-words text-[11px] text-gray-500">{child.description.slice(0, 600)}{child.description.length > 600 ? "…" : ""}</p>}
        {present && child ? <Field schema={child} value={value[key]} onChange={next => onChange({ ...value, [key]: next })} label={name} depth={depth} dataSources={dataSources} allowReferences={allowReferences} /> : <p className="text-[10px] text-gray-500">{present ? "Existing value preserved below" : "Not supplied"}</p>}
        {present ? <button type="button" className="text-[10px] text-gray-500 hover:text-red-600" onClick={() => onChange(Object.fromEntries(Object.entries(value).filter(([old]) => old !== key)))}>Remove {key}</button> : child && <button type="button" className="text-xs text-primary" onClick={() => onChange({ ...value, [key]: initial(child) })}>Set {key}</button>}
      </div>;
    })}
    {keys.length > 50 && <p className="text-xs text-gray-500">Additional declared fields are preserved but not displayed.</p>}
    {(Object.keys(extras).length > 0 || schema.additionalProperties !== false) && <details className="text-xs"><summary className="cursor-pointer">Additional fields{schema.additionalProperties === false ? " · not allowed by this schema" : " · schema type unknown"}</summary><div className="mt-3"><ValueFields value={extras} onChange={next => onChange({ ...Object.fromEntries(Object.entries(value).filter(([key]) => Object.hasOwn(properties, key))), ...next })} label={`${label} additional`} /></div></details>}
    {!keys.length && schema.additionalProperties === false && <p className="text-xs text-gray-500">No parameters declared</p>}
  </div>;
}
