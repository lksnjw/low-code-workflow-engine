import { Icon } from "@iconify/react";
import { isGovernanceBlock } from "../../constants/workflowStatus";
import StepLogItem from "./StepLogItem";

function ExecutionTimeline({ timeline = [] }) {
  if (timeline.length === 0) return <p className="text-sm text-gray-500">No step timeline was recorded.</p>;
  return (
    <div className="space-y-3">
      {timeline.map((step, index) => {
        const blocked = isGovernanceBlock(step.failure);
        // A blocked step reads BLOCKED, not FAILED: nothing crashed.
        const chip = blocked ? "BLOCKED" : step.status;
        const label = step.label || step.nodeId;
        return (
          <div
            key={step.id || `${step.nodeId}-${index}`}
            data-testid="timeline-step"
            data-blocked={blocked ? "true" : "false"}
          >
            <StepLogItem index={index} log={`${label}: ${chip}`} tone={blocked ? "blocked" : undefined} />
            {blocked ? (
              <p className="ml-9 mt-1 flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
                <Icon icon="mdi:shield-alert-outline" className="h-4 w-4" />
                Blocked by {step.failure.ruleId} — tool never called
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export default ExecutionTimeline;
