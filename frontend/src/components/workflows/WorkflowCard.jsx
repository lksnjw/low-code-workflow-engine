import { Icon } from "@iconify/react";
import Card from "../shared/ui/Card";
import WorkflowBadge from "./WorkflowBadge";

function WorkflowCard({ workflow, onOpen }) {
  return (
    <Card as="button" type="button" onClick={onOpen} className="flex h-full w-full flex-col text-left transition hover:-translate-y-0.5 hover:shadow-lg">
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Icon icon="tabler:git-branch" className="h-5 w-5" />
        </span>
        <WorkflowBadge status={workflow.status} />
      </div>
      <h3 className="mt-4 text-base font-bold text-gray-950 dark:text-white">{workflow.name}</h3>
      <p className="mt-2 flex-1 text-sm leading-6 text-gray-500 dark:text-gray-400">
        {workflow.description}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {(workflow.domainTags || []).map((domain) => (
          <span key={domain} className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">{domain}</span>
        ))}
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${workflow.canRun ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"}`}>
          {workflow.canRun ? "You can run this" : "View only"}
        </span>
      </div>
      <div className="mt-5 grid grid-cols-3 gap-3 rounded-xl bg-backgroundLight p-3 text-center dark:bg-darkBackgroundVery">
        <div>
          <p className="text-xs text-gray-500">Steps</p>
          <p className="font-bold text-gray-900 dark:text-white">{workflow.steps}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Success</p>
          <p className="font-bold text-gray-900 dark:text-white">{workflow.successRate}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Last Run</p>
          <p className="font-bold text-gray-900 dark:text-white">{workflow.lastRun}</p>
        </div>
      </div>
    </Card>
  );
}

export default WorkflowCard;
