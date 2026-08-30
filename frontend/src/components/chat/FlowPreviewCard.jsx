import Card from "../shared/ui/Card";
import Badge from "../shared/ui/Badge";

/*******************************************************************************
 * Function: FlowPreviewCard
 *
 * Performs the Flow Preview Card operation on preview card for the FlowPreviewCard module.
 ******************************************************************************/
function FlowPreviewCard({ artifact }) {
  const summary = artifact?.validation_summary;
  const canExecute = artifact?.can_execute;

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-base font-bold text-gray-950 dark:text-white">Validation</h3>
        <Badge tone={canExecute ? "success" : "warning"}>{canExecute ? "Executable" : "Blocked"}</Badge>
      </div>
      {summary ? (
        <div className="space-y-3 text-sm text-gray-700 dark:text-gray-200">
          <p>Passed candidates: {summary.passed_candidates}</p>
          <p>Blocked candidates: {summary.blocked_candidates}</p>
          <p>Best score: {summary.best_score}</p>
          {artifact?.selected_candidate_id ? <p>Selected: {artifact.selected_candidate_id}</p> : null}
        </div>
      ) : (
        <p className="text-sm text-gray-500">Send a request to validate generated workflow candidates.</p>
      )}
    </Card>
  );
}

export default FlowPreviewCard;
