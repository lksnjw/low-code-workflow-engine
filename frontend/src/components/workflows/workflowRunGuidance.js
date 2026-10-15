import { parseWorkflowPreview } from "../chat/workflowPreview";

const strings = value => Array.isArray(value) ? value.filter(item => typeof item === "string" && item.trim()).map(item => item.slice(0, 800)) : [];

/** Explains the server's readiness result; it never grants execution access. */
export function workflowRunGuidance(record) {
  if (!record || record.can_attempt_run === true) return [];
  const preview = parseWorkflowPreview(record.yaml);
  const reasons = [
    ...strings(preview.metadata?.unresolved_requirements),
    ...strings(record.validation?.errors),
    ...strings(record.issues),
  ];
  if (record.published === false || record.compilation?.state === "NOT_PUBLISHED" || record.publishedVersion === 0)
    reasons.push("This draft has not been published. Review its steps, then publish the reviewed draft.");
  if (record.compilation?.state === "BLOCKED") reasons.push("Its approved tools have changed. Review the current tool access and publish the draft again.");
  // An empty draft has no connection to discover; that is not evidence of a
  // broken account connection.
  if (preview.steps.length > 0 && record.bridge && record.bridge !== "discovery_available") reasons.push("The ERP connection could not be checked. Check your ERP connection in Profile, then check this workflow again.");
  if (typeof record.yaml === "string" && !preview.error && preview.steps.length === 0) reasons.push("The draft has no steps yet. Ask the assistant to complete the workflow.");
  if (!reasons.length) reasons.push("Current run access or a required review is blocking this workflow. Ask the assistant to check this saved workflow and explain the next action.");
  return [...new Set(reasons)].slice(0, 30);
}

export function workflowRunHelpMessage(record, inputIssues = []) {
  return [
    "Help me get this saved workflow ready to run. Check its current draft, publication, tool access and required inputs.",
    ...[...new Set([...workflowRunGuidance(record), ...strings(inputIssues)])].slice(0, 30).map(issue => `Needs attention: ${issue}`),
    "Explain the next step in plain English. Ask me for missing business values one at a time and prepare any workflow changes for my review. Do not invent required values, publish, run, approve a transaction or activate a schedule from this help request.",
  ].join("\n");
}
