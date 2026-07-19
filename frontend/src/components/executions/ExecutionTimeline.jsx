import StepLogItem from "./StepLogItem";

function ExecutionTimeline({ timeline = [] }) {
  if (timeline.length === 0) return <p className="text-sm text-gray-500">No step timeline was recorded.</p>;
  return <div className="space-y-3">{timeline.map((step, index) => <StepLogItem key={step.id || `${step.nodeId}-${index}`} log={`${step.label || step.nodeId}: ${step.status}`} index={index} />)}</div>;
}

export default ExecutionTimeline;
