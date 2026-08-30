/*******************************************************************************
 * Function: ruleIdFor
 *
 * Performs the rule Id For operation on id for for the GateRejectionAlert module.
 ******************************************************************************/
function ruleIdFor(value) {
  if (typeof value === "string") return value;
  return value?.rule_id || value?.ruleId || value?.id || "";
}

/*******************************************************************************
 * Function: failureItems
 *
 * Performs the failure Items operation on items for the GateRejectionAlert module.
 ******************************************************************************/
function failureItems(meta) {
  if (!meta || typeof meta !== "object") return [];

  const errors = Array.isArray(meta.errors) ? meta.errors : [];
  const failedRules = Array.isArray(meta.failed_rules) ? meta.failed_rules : [];
/*******************************************************************************
 * Function: items
 *
 * Performs the items operation on the application for the GateRejectionAlert module.
 ******************************************************************************/
  const items = errors.map((error, index) => {
    const entry = error && typeof error === "object" ? error : {};
    const ruleId = ruleIdFor(entry) || ruleIdFor(failedRules[index]);
    const message = entry.message || entry.reason || (typeof error === "string" ? error : "Validation failed");
    const step = entry.step_id || entry.stepId || entry.step;
    const field = entry.field || entry.path;
    const locations = [step ? `step: ${step}` : "", field ? `field: ${field}` : ""].filter(Boolean);

    return {
      key: `${ruleId || "validation"}-${index}`,
      ruleId,
      message,
      location: locations.length ? ` (${locations.join(", ")})` : "",
    };
  });

/*******************************************************************************
 * Function: represented
 *
 * Performs the represented operation on the application for the GateRejectionAlert module.
 ******************************************************************************/
  const represented = new Set(items.map((item) => item.ruleId).filter(Boolean));
  failedRules.forEach((rule, index) => {
    const ruleId = ruleIdFor(rule);
    if (!ruleId || represented.has(ruleId)) return;
    const ruleMessage = typeof rule === "object" ? rule.message || rule.reason : "";
    items.push({
      key: `${ruleId}-${errors.length + index}`,
      ruleId,
      message: ruleMessage || "Validation failed",
      location: "",
    });
  });

  return items;
}

/*******************************************************************************
 * Function: GateExplanationPanel
 *
 * Performs the Gate Explanation Panel operation on explanation panel for the GateRejectionAlert module.
 ******************************************************************************/
function GateExplanationPanel({ gateExplanation }) {
  if (!gateExplanation || !Array.isArray(gateExplanation.explanations) || gateExplanation.explanations.length === 0) return null;
  return (
    <div className="mt-2 rounded border border-red-300 bg-red-100 px-3 py-2 text-xs text-red-900">
      <p className="mb-1 font-semibold uppercase tracking-wide text-red-700">Policy Details</p>
      <ul className="space-y-2">
        {gateExplanation.explanations.map((entry, i) => (
          <li key={entry.ruleId || i} className="border-l-2 border-red-400 pl-2">
            <p className="font-semibold">{entry.ruleFamily}</p>
            {entry.condition ? <p className="mt-0.5 text-red-800">{entry.condition}</p> : null}
            {entry.message ? <p className="mt-0.5 italic text-red-700">{entry.message}</p> : null}
          </li>
        ))}
      </ul>
      {gateExplanation.registryHash ? (
        <p className="mt-2 font-mono text-red-500 text-xs opacity-60">registry: {gateExplanation.registryHash} · policy v{gateExplanation.policyVersion}</p>
      ) : null}
    </div>
  );
}

/*******************************************************************************
 * Function: GateRejectionAlert
 *
 * Performs the Gate Rejection Alert operation on rejection alert for the GateRejectionAlert module.
 ******************************************************************************/
function GateRejectionAlert({ details }) {
  if (!details?.message) return null;
  const failures = failureItems(details.meta);
  const gateExplanation = details.meta?.gateExplanation;

  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
      <p className="font-semibold">{details.message}</p>
      <TraceIdentifier traceId={details.meta?.traceId || details.traceId} />
      {failures.length ? (
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {failures.map((failure) => (
            <li key={failure.key}>
              {failure.ruleId ? <span className="font-mono font-bold">{failure.ruleId}</span> : null}
              {failure.ruleId ? ": " : ""}
              {failure.message}
              {failure.location}
            </li>
          ))}
        </ul>
      ) : null}
      <GateExplanationPanel gateExplanation={gateExplanation} />
    </div>
  );
}

export default GateRejectionAlert;
import TraceIdentifier from "../shared/TraceIdentifier";
