/** Plain-language orientation only. Exact server requirements remain authoritative. */
export default function WorkflowRequirementSummary({ issues = [] }) {
  const reasons = issues.filter(issue => typeof issue === "string");
  const access = reasons.some(issue => /not (?:available|offered)|no .*tool|capabilit|tool.*access|permission/i.test(issue));
  const details = reasons.some(issue => /recipient|timezone|time zone|time of day|reporting period|delivery channel|not (?:provided|confirmed)|required field/i.test(issue));
  const structure = reasons.some(issue => /schema|mapping|binding|output|checkpoint|template/i.test(issue));
  return <div className="space-y-2 text-xs leading-5 text-gray-600 dark:text-gray-300">
    <p className="font-semibold text-gray-900 dark:text-gray-100">Why it cannot run</p>
    <ul className="list-disc space-y-1 pl-4">
      {access && <li>A required ERP or email tool is unavailable to this workflow. Ask the assistant to check the current connection and tool access.</li>}
      {details && <li>Some business details are missing. Tell the assistant the recipient, time or other details it asks for.</li>}
      {structure && <li>Some steps or data connections are incomplete. Ask the assistant to repair the draft using the available tools.</li>}
      {!access && !details && !structure && <li>The draft is incomplete. Ask the assistant to check its requirements and help you finish it.</li>}
    </ul>
    <p><strong>Next:</strong> Choose “Complete in chat” and say “Help me finish this workflow.” Review the updated draft before publishing or running it.</p>
  </div>;
}
