# Final Consolidation Status

Assessment date: 2026-08-20

Branch: `feat/final-consolidation`

## Verdict

G1 is enforced in the default production build: the server has no Baseline B wiring, the tool interface requires a validator-minted dispatch capability, and MCP rejects zero or parameter-mismatched capabilities before transport. Evidence: `TestProductionConfigIgnoresExperimentBaselineEnvironment`, `TestRunnerRejectsMissingOrMismatchedValidationTokenWithoutExecution`, `TestMCPClientZeroValueCapabilityMakesNoHTTPRequest`, `TestMCPClientMutatedParametersFailHashWithoutHTTPRequest`, and `TestMCPClientRemoteModePostsToMiddleware`.

G2 remains partial. Implemented deferred threshold/required-parameter rules and sensitive-key scans run after resolution, but no test establishes a complete dispatch-time replay of separation-of-duties or a recorded approval lifecycle. Evidence for the enforced subset: `TestDeferredThresholdDispatch`, `TestDeferredRequiredParameterRevalidatedAtDispatch`, `TestResolvedSensitiveKeyAbortsBeforeTool`, and `TestDeferredCheckWithoutEvaluatorFailsClosed`.

G3, G4, and G5 are NOT ENFORCED. There are no proving tests for idempotent external effects, a pause/approve/resume lifecycle tied to a distinct principal, or complete tamper-resistant provenance.

## Baseline B

Baseline B was preserved for the experiment. It is compiled with `-tags experiment`, records would-block decisions, and may dispatch only to tools implementing the experiment spy/no-op marker. A real MCP tool prevents gate-off enablement. Evidence: `TestBaselineBExecutesDispatchViolationAndAuditsBypass`, `TestBaselineBHandlerExecutesPlanBlockedWorkflowAndAuditsBypass`, `TestExperimentGateOffRejectsRealMCPToolRegistry`, and `TestExperimentHarnessProducesCSVAndMetricsForFourCases`.

## Rule evaluator gaps

The explicit `NO_EVALUATOR` families are:

- `execution_safety`
- `capability_gap`
- `cache_safety`

An enabled rule in one of these families blocks validation and is included in the startup warning list. Evidence: `TestEnabledCacheSafetyRuleFailsClosedWithRuleAndFamily` and `TestEnabledRulesWithoutEvaluatorListsExactlyUnimplementedFamilies`.

## Out-of-scope work left unchanged

- G3 idempotency and retry deduplication: NOT ENFORCED; no proving test carries a stable key through retry and external dispatch.
- G4 runtime approval lifecycle: NOT ENFORCED; no proving test covers a durable approval record, execution suspension/resumption, and approval by a principal distinct from the requester.
- G5 provenance completeness and tamper resistance: NOT ENFORCED; no proving test exists.
- Smart Dispatcher: NOT IMPLEMENTED. The component specified in `CLAUDE.md` is future work; existing hard-coded orchestration branches are not the specified dispatcher.
- Multi-model generation study: specified but not run. The dataset labels the workflow artifact, not the instruction. A model receiving an unsafe instruction that emits a safe workflow would be scored as a gate false negative, conflating model refusal behaviour with gate recall. Sound execution requires independent labelling of every generated artifact. The study measures generation quality, not enforcement; enforcement invariance is established structurally.

## Consolidated evidence

The existing Day 3A artifacts show gate-on TP=54, FP=0, TN=60, FN=6 with `GLOBAL-SOD-001` disabled and TP=60, FP=0, TN=60, FN=0 with it enabled. Exactly `unsafe_separation_of_duties_01` through `_06` changed from allow to block. Full setup, hashes, metrics, and disclosures are in `docs/RESULTS.md`.

Model independence is established structurally rather than through a multi-model sample. Evidence: `TestGateVerdictsAreDeterministicAcrossRepeatedRuns` (`600/600` identical), `TestGateVerdictIsInvariantToModelProvenance`, and `TestValidatorImportsNoModelOrSynthesisPackage`.
