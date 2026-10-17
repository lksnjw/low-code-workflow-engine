import type { CandidateValidationResult } from "./registry-validator.js";

// These names are selected by server execution entrypoints, not draft metadata.
// Free-text authoring notes do not grant or deny execution authority. Actual
// registered policies, tool schemas, roles and approval checks still apply.
const runtimeValidationActions = new Set([
  "StartWorkflowAgent", "RunWorkflow", "QueueReadWorkflow", "ReadJobWorker",
  "ReadToolBroker", "ReadConfirmedPath", "ReadConfirmedIterations",
  "ReadConfirmedAgentInvocation", "ReadConfirmedProtectedInvocation",
  "OperationJobWorker", "OperationReadbackQuery", "ProtectedOperationAdmission",
  "ProtectedOperationWorker", "ProtectedEffectBroker", "ProtectedEffectConfirmedPath",
]);

export function validateRequirementNotes(action: string, notes: unknown, result: CandidateValidationResult): void {
  let error: string | undefined;
  if (notes !== undefined && (!Array.isArray(notes) || notes.length > 50 ||
      notes.some(note => typeof note !== "string" || !note.trim() || note.length > 2048))) {
    result.schema_ok = false;
    error = "Requirement blockers must be an array of at most 50 nonempty bounded strings";
  } else if (Array.isArray(notes) && notes.length) {
    if (runtimeValidationActions.has(action)) {
      result.warnings.push("WORKFLOW_REQUIREMENT_NOTES: Execute the saved steps; draft notes are not evidence that additional outcomes were completed.");
      result.metadata.runtime_requirement_notes = [...notes];
    } else {
      result.policy_ok = false;
      error = "The proposal explicitly contains unresolved requested outcomes, policy obligations or required inputs";
    }
  }
  if (error) { result.failed_rules.push("UNRESOLVED_REQUIREMENTS"); result.errors.push(error); }
}
