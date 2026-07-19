# Validation and Dispatch Invariants

## G1 — ENFORCED: deterministic validation gate cannot be bypassed

The full `RegistryValidator` is constructor-required by both the API handler and runner. A successful gate decision issues a token bound to the SHA-256 hash of the exact workflow YAML and the loaded tool/rule registry versions. The runner rejects a missing token, a content mismatch, or a registry mismatch before executing a step.

Every full-gate decision is appended through the existing repository audit helper with the path/action, pass/fail result, rule results, registry hash, workflow content hash, and timestamp.

| Gated path or invariant | Proving test |
|---|---|
| Handler and runner cannot be constructed with a nil registry validator | `TestHandlerConstructorRejectsNilRegistryValidator`, `TestRunnerConstructorRejectsNilValidator` |
| `CreateWorkflow` rejects invalid YAML without persistence | `TestWorkflowWritePathsRejectInvalidDefinitionsWithoutPersistence/CreateWorkflow` |
| `UpdateWorkflow` rejects an invalid stored definition without mutation | `TestWorkflowWritePathsRejectInvalidDefinitionsWithoutPersistence/UpdateWorkflow` |
| `PutWorkflowYAML` rejects invalid replacement YAML without mutation | `TestWorkflowWritePathsRejectInvalidDefinitionsWithoutPersistence/PutWorkflowYAML` |
| `PublishWorkflow` revalidates and rejects invalid stored YAML | `TestPublishAndRestoreRejectStoredInvalidYAML/PublishWorkflow` |
| `RestoreWorkflowVersion` revalidates and rejects invalid version YAML | `TestPublishAndRestoreRejectStoredInvalidYAML/RestoreWorkflowVersion` |
| `UseTemplate` rejects an invalid instantiated workflow without persistence or an empty-canvas fallback | `TestUseTemplateInvalidResultDoesNotPersistOrCreateEmptyCanvas` |
| `ValidateWorkflow`, `SynthesisValidate`, and `CanvasValidateWorkflow` return the full registry result | `TestFullGateValidationEndpointsRejectUnknownTool` |
| A semantic canvas edit marks the workflow `draft-unvalidated`, and `RunWorkflow` refuses it | `TestCanvasSemanticChangeMarksDraftUnvalidatedAndRunRefuses` |
| `runner.Run` rejects nil, forged, and hash-mismatched tokens before execution | `TestRunnerRejectsMissingOrMismatchedValidationTokenWithoutExecution` |
| Unknown YAML fields are rejected by strict decoding | `TestUnknownYAMLFieldRejectedByStrictGate` |
| Gate decisions contain the required audit evidence | `TestGateDecisionsAreRecordedWithRequiredAuditEvidence` |

## G2 — ENFORCED: resolved values are revalidated at dispatch

Threshold, sensitive-data, and parameter-rule checks that depend on unresolved templates are recorded in the validation token. After state resolution and immediately before tool dispatch, the runner calls the validator's shared evaluators and scans the resolved parameter map for sensitive keys. Unknown deferred evaluators fail closed. Dispatch violations expose only the first four characters of the offending value, mark the execution `FAILED`, and do not enter healing.

| Dispatch invariant | Proving test |
|---|---|
| Literal over-threshold values fail during planning | `TestLiteralOverThresholdRejectedAtPlanTime` |
| Under-threshold resolved values retain a deferred check and execute | `TestDeferredThresholdDispatch/under_threshold_executes` |
| Over-threshold resolved values abort before the spy tool executes | `TestDeferredThresholdDispatch/over_threshold_aborts_before_tool` |
| Resolved credential-like keys abort before the spy tool executes | `TestResolvedSensitiveKeyAbortsBeforeTool` |
| Required parameters are rechecked after template resolution | `TestDeferredRequiredParameterRevalidatedAtDispatch` |
| Dispatch policy violations mark execution `FAILED` and bypass healing | `TestDispatchViolationMarksExecutionFailedWithoutHealing` |
| Deferred rules without an evaluator fail closed before tool execution | `TestDeferredCheckWithoutEvaluatorFailsClosed` |
