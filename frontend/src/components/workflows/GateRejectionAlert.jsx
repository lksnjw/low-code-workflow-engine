function ruleIdFor(value) {
  if (typeof value === "string") return value;
  return value?.rule_id || value?.ruleId || value?.id || "";
}

function failureItems(meta) {
  if (!meta || typeof meta !== "object") return [];

  const errors = Array.isArray(meta.errors) ? meta.errors : [];
  const failedRules = Array.isArray(meta.failed_rules) ? meta.failed_rules : [];
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

function GateRejectionAlert({ details }) {
  if (!details?.message) return null;
  const failures = failureItems(details.meta);

  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
      <p className="font-semibold">{details.message}</p>
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
    </div>
  );
}

export default GateRejectionAlert;
