import { useState } from "react";
import Button from "../shared/ui/Button";
import Fields, { fullyVisible } from "./CapabilityFields";
import { reviewDataClasses, sensitivityOptions } from "./capabilityReviewPolicy";
import { operationOutputFields } from "./discoveredReviewPolicy";

const inputClass = "mt-1 w-full rounded-md border border-gray-300 bg-transparent px-3 py-2 text-sm dark:border-gray-700";
export default function DiscoveredCapabilityReview({ item, roles, canReview, onReview }) {
  const [effect, setEffect] = useState(""), [selectedRoles, setSelectedRoles] = useState([]), [dataClass, setDataClass] = useState("");
  const [risk, setRisk] = useState(""), [note, setNote] = useState(""), [confirmed, setConfirmed] = useState(false);
  const [effects, setEffects] = useState(""), [outputIndex, setOutputIndex] = useState(""), [expected, setExpected] = useState("");
  const [meaning, setMeaning] = useState("operation-accepted");
  const definition = item.definition, operation = effect && effect !== "read", outputs = operationOutputFields(definition?.bridge_contract?.output_schema);
  const readAlias = definition?.bridge_contract?.selector === "digest-pinned-alias";
  const operationAlias = definition?.bridge_contract?.selector === "digest-pinned-operation-alias";
  const preset = operationAlias ? definition.operation_contract : null;
  const proof = preset ? { path: preset.confirmation.path, type: "string" } : outputs[Number(outputIndex)], outputSelected = Boolean(preset) || outputIndex !== "" && Boolean(proof);
  const expectedValue = preset ? preset.confirmation.expected : proof?.type === "boolean" ? expected === "true" : ["number", "integer"].includes(proof?.type) ? Number(expected) : expected;
  const sideEffects = effects.split("\n").map(value => value.trim()).filter(Boolean);
  const validOperation = !operation || outputSelected && (preset || expected !== "") && (!operationAlias || effect === "write" && risk === "medium") && sideEffects.length > 0 && sideEffects.length <= 32 &&
    sideEffects.every(value => value.length <= 256) && (typeof expectedValue !== "number" || Number.isFinite(expectedValue)) &&
    (proof.type !== "integer" || Number.isInteger(expectedValue));
  const roleOptions = Array.isArray(roles) && roles.length <= 256 && roles.every(value => typeof value?.id === "string" && typeof value?.name === "string" && value.name.trim() && value.name.length <= 128) && new Set(roles.map(value => value.name)).size === roles.length ? roles : [];
  const importable = item.importable === true && Boolean(definition?.bridge_contract && Array.isArray(definition.bridge_contract.remote_roles) && definition.input_schema);
  const allowed = canReview && importable && fullyVisible(definition) && roleOptions.length > 0;
  const ready = allowed && effect && !(readAlias && operation) && (!operationAlias || effect === "write" && risk === "medium") && selectedRoles.length > 0 && selectedRoles.length <= 32 && reviewDataClasses(Boolean(operation)).includes(dataClass) &&
    (operation ? ["low", "medium"].includes(risk) : !item.hints?.destructive) && note.trim() && confirmed && validOperation;
  function submit(event) {
    event.preventDefault(); if (!ready) return;
    onReview(item, { allowedRoles: selectedRoles, effectClass: effect, riskClass: operation ? risk : "low", dataClass, retryPolicy: "never", confirmed: true, note: note.trim(),
      ...(operation ? { sideEffects, requireIndependentApproval: true, operationContract: preset ?? { profile: "operation-result/v1", effect_class: effect, retry_policy: "never",
        confirmation: { path: proof.path, expected: expectedValue, meaning } } } : {}) });
  }
  return <form aria-label="Review discovered tool" onSubmit={submit} className="mt-5 space-y-5 border-t border-gray-200 pt-5 dark:border-gray-800">
    <div><h3 className="text-base font-semibold">Review discovered tool</h3><p className="mt-1 break-words text-sm">{definition?.display_name ?? item.remoteName}</p>
      <p className="mt-1 text-sm text-gray-500">This tool is not enabled. Choose its contract policy explicitly; gateway hints are not permission.</p></div>
    {!importable ? <p role="alert">{item.unsupportedReason ?? "This remote contract is not supported for import."}</p> : null}
    {importable ? <details><summary className="cursor-pointer text-sm font-semibold">Inspect inputs, output and remote roles</summary><div className="mt-3 space-y-4 text-sm">
      <p className="whitespace-pre-wrap">{definition.description}</p><p>Version: {definition.bridge_contract?.resource_version}</p><p className="break-all">Local action: {definition.name}</p>
      <section aria-label="Discovered inputs"><h4 className="font-semibold">Inputs</h4><Fields value={definition.input_schema} /></section>
      <section aria-label="Discovered output"><h4 className="font-semibold">Output contract</h4><Fields value={definition.bridge_contract?.output_schema} /></section>
      <p>Remote roles: {definition.bridge_contract?.remote_roles.join(", ") || "No transport role selector"}</p>
      <p>Gateway hint: {item.hints?.readOnly ? "read-only" : "not attested read-only"}{item.hints?.destructive ? "; destructive" : ""}. Review still required.</p>
    </div></details> : null}
    {!roleOptions.length ? <p className="text-sm text-amber-700">Current role choices are unavailable. Reload review status before importing.</p> : null}
    {importable ? <fieldset disabled={!allowed} className="space-y-4">
      {readAlias && <p className="text-sm text-gray-500">This digest-pinned serving alias supports reviewed reads only. It cannot be imported for writes or email delivery.</p>}
      {operationAlias && <section aria-label="ERPNext write receipt profile" className="rounded-md border border-amber-300 p-3 text-sm"><p>ERPNext document write: medium risk, independent transaction approval, exact changed-field receipt checks and no automatic retry. A draft Material Receipt does not add stock quantity. Submission and deletion are not enabled by this profile.</p><Fields value={preset} /></section>}
      <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium">Reviewed effect<select aria-label="Discovered tool effect" className={inputClass} value={effect} onChange={event => { setEffect(event.target.value); setDataClass(""); setConfirmed(false); }}><option value="">Choose effect</option><option value="read" disabled={item.hints?.destructive}>Read only</option><option value="write" disabled={readAlias}>Write</option><option value="notification" disabled={readAlias}>Notification</option></select></label>
        <label className="text-sm font-medium">Data sensitivity<select aria-label="Discovered tool sensitivity" className={inputClass} value={dataClass} onChange={event => setDataClass(event.target.value)}><option value="">Choose sensitivity</option>{sensitivityOptions.filter(option => reviewDataClasses(Boolean(operation)).includes(option.value)).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label></div>
      <fieldset><legend className="text-sm font-medium">Allowed application roles</legend><div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">{roleOptions.map(value => <label key={value.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selectedRoles.includes(value.name)} onChange={event => setSelectedRoles(current => event.target.checked ? [...current, value.name] : current.filter(role => role !== value.name))} />{value.name}</label>)}</div></fieldset>
      {operation ? <div className="space-y-4 border-l-2 border-gray-200 pl-4 dark:border-gray-700"><p className="text-sm">Every execution needs independent approval. Importing this contract does not send or update anything.</p>
        <label className="block text-sm font-medium">Operation risk<select aria-label="Discovered operation risk" className={inputClass} value={risk} onChange={event => setRisk(event.target.value)}><option value="">Choose risk</option><option value="low">Low</option><option value="medium">Medium</option></select></label>
        <label className="block text-sm font-medium">Side effects (one per line)<textarea aria-label="Discovered operation side effects" className={inputClass} value={effects} onChange={event => setEffects(event.target.value)} maxLength={8192} /></label>
        <fieldset hidden={operationAlias} aria-hidden={operationAlias}>
        <label className="block text-sm font-medium">Confirmation output<select aria-label="Discovered confirmation output" className={inputClass} value={outputIndex} onChange={event => { setOutputIndex(event.target.value); setExpected(""); }}><option value="">Choose declared output</option>{outputs.map((value, index) => <option key={value.path.join(".")} value={index}>{value.path.join(" › ")} ({value.type})</option>)}</select></label>
        {outputSelected ? <label className="block text-sm font-medium">Expected confirmation value{proof.type === "boolean" ? <select aria-label="Discovered confirmation value" className={inputClass} value={expected} onChange={event => setExpected(event.target.value)}><option value="">Choose value</option><option value="true">True</option><option value="false">False</option></select> : <input aria-label="Discovered confirmation value" className={inputClass} type={["number", "integer"].includes(proof.type) ? "number" : "text"} step={proof.type === "integer" ? "1" : "any"} maxLength={256} value={expected} onChange={event => setExpected(event.target.value)} />}</label> : null}
        <label className="block text-sm font-medium">Receipt meaning<select aria-label="Discovered receipt meaning" className={inputClass} value={meaning} onChange={event => setMeaning(event.target.value)}><option value="operation-accepted">Operation accepted (not delivery proof)</option><option value="operation-confirmed">Operation confirmed</option></select></label>
        </fieldset>
      </div> : <p className="text-sm text-gray-500">Read policy: low risk, no effects, no automatic ERP retry.</p>}
      <label className="block text-sm font-medium">Review note<textarea aria-label="Discovered tool review note" className={inputClass} value={note} onChange={event => setNote(event.target.value)} maxLength={2000} /></label>
      <label className="flex items-start gap-2 text-sm"><input aria-label="Confirm discovered contract review" className="mt-1" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>I reviewed the current schemas, roles, effect and data sensitivity. This decision does not execute the tool.</span></label>
      <Button type="submit" disabled={!ready}>Review and add tool</Button>
    </fieldset> : null}
  </form>;
}
