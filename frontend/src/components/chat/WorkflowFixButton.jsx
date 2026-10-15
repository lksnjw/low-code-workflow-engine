import { useState } from "react";
import WorkflowDialog from "../workflows/WorkflowDialog";
import { useChatWorkspace } from "./ChatWorkspaceContext";
import WorkflowRequirementSummary from "./WorkflowRequirementSummary";

// These fields collect user instructions, not an alternate validation schema.
const questions = [
  { key: "recipient", match: /recipient|delivery address/i, label: "Recipient email", type: "email" },
  { key: "channel", match: /delivery channel/i, label: "Delivery method", options: ["Email", "Show results in the app"] },
  { key: "timezone", match: /timezone|time zone/i, label: "Timezone", placeholder: "For example, Asia/Colombo" },
  { key: "time", match: /time of day|send time|delivery time|local time/i, label: "Time of day", type: "time" },
  { key: "period", match: /reporting period|report window|reporting window/i, label: "Report period", options: ["Previous calendar day", "Today so far", "Current records only"] },
  { key: "analysis", match: /analysis scope|raw.*analysis/i, label: "Report content", options: ["Raw records", "Summary and analysis"] },
];

export default function WorkflowFixButton({ workflowId, requirements = [], errors = [], busy = false }) {
  const workspace = useChatWorkspace();
  const [open, setOpen] = useState(false), [answers, setAnswers] = useState({}), [notes, setNotes] = useState("");
  if (!workspace?.requestWorkflowHelp || !/^[A-Za-z0-9_-]{1,128}$/.test(workflowId || "")) return null;
  const issues = [...new Set([...requirements, ...errors].filter(value => typeof value === "string" && value.trim()))].slice(0, 50);
  const fields = questions.filter(question => issues.some(issue => question.match.test(issue)));
  const prepare = () => {
    const supplied = fields.filter(field => answers[field.key]?.trim()).map(field => `${field.label}: ${answers[field.key].trim()}`);
    if (notes.trim()) supplied.push(`My instructions: ${notes.trim()}`);
    workspace.requestWorkflowHelp(workflowId, [
      "Help me complete this workflow. Check the current saved draft and its missing requirements.",
      ...supplied,
      "Check which required ERP capabilities are currently available to me. Ask me the remaining questions in plain language, then prepare the necessary workflow changes for review. Keep unresolved requirements visible until they are actually resolved. Do not run, send email or activate a schedule yet.",
    ].join("\n"));
    setOpen(false);
  };
  return <>
    <button type="button" disabled={busy} onClick={() => setOpen(true)} className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white hover:bg-primary/90 disabled:opacity-50">Fix missing details</button>
    <WorkflowDialog open={open} title="Complete workflow details" onClose={() => setOpen(false)} busy={busy}>
      <form className="space-y-4 text-sm" onSubmit={event => { event.preventDefault(); if (!busy) prepare(); }}>
        <p>Enter what you know. Leave anything uncertain blank and the assistant will help you resolve it.</p>
        <WorkflowRequirementSummary issues={issues} />
        {issues.length > 0 && <details className="border-l-2 border-amber-400 pl-3 text-xs"><summary className="cursor-pointer font-semibold">Technical requirements ({issues.length})</summary><ul className="mt-2 list-disc space-y-2 pl-4">{issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}
        <div className="grid gap-3 sm:grid-cols-2">{fields.map(field => <label key={field.key} className="block text-xs font-medium">{field.label}
          {field.options ? <select value={answers[field.key] || ""} onChange={event => setAnswers(value => ({ ...value, [field.key]: event.target.value }))} disabled={busy} className="mt-1 w-full rounded-lg border border-gray-300 bg-transparent p-2 dark:border-gray-600"><option value="">Ask me / not decided</option>{field.options.map(option => <option key={option}>{option}</option>)}</select>
            : <input type={field.type || "text"} placeholder={field.placeholder} maxLength={254} value={answers[field.key] || ""} onChange={event => setAnswers(value => ({ ...value, [field.key]: event.target.value }))} disabled={busy} className="mt-1 w-full rounded-lg border border-gray-300 bg-transparent p-2 dark:border-gray-600" />}
        </label>)}</div>
        <label className="block text-xs font-medium">Other details or changes<textarea rows={3} maxLength={4000} value={notes} onChange={event => setNotes(event.target.value)} disabled={busy} className="mt-1 w-full rounded-lg border border-gray-300 bg-transparent p-2 dark:border-gray-600" placeholder="For example: show the report here first, and ask me before sending it." /></label>
        <p className="text-xs text-gray-500">This prepares a message in this chat. Review it and press Send. Your existing message is kept. Tool access and validation will be checked by the server.</p>
        <div className="flex flex-wrap justify-end gap-2"><button type="button" disabled={busy} onClick={() => setOpen(false)} className="rounded-lg border px-3 py-2 text-xs">Close without changes</button><button type="submit" disabled={busy} className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Prepare message to fix workflow</button></div>
      </form>
    </WorkflowDialog>
  </>;
}
