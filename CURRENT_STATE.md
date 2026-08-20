# Current Research Implementation State

Assessment date: 2026-08-20

Branch: `feat/final-consolidation`

This document reports the validation and dispatch properties exercised by named tests. It does not assert deployment readiness or completeness beyond those tests.

## Core claim

The production build requires a validator-issued capability at every `Tool.Execute` and `MCPClient.Execute` call. The capability is minted after dispatch-time evaluation and binds the workflow content hash, registry hash, step index, action, and resolved-parameter hash. Evidence: `TestRunnerRejectsMissingOrMismatchedValidationTokenWithoutExecution`, `TestMCPClientZeroValueCapabilityMakesNoHTTPRequest`, `TestMCPClientMutatedParametersFailHashWithoutHTTPRequest`, and `TestMCPClientRemoteModePostsToMiddleware`.

Baseline B remains a research comparison artifact compiled only with the `experiment` build tag. Gate-off enablement accepts spy/no-op tools and rejects a real MCP-backed registry. Evidence: `TestBaselineBExecutesDispatchViolationAndAuditsBypass`, `TestBaselineBHandlerExecutesPlanBlockedWorkflowAndAuditsBypass`, and `TestExperimentGateOffRejectsRealMCPToolRegistry`.

`EXPERIMENT_BASELINE` is inert in the production configuration and the production server does not call an experiment setter. Evidence: `TestProductionConfigIgnoresExperimentBaselineEnvironment` plus the production-binary symbol/string check recorded in the Day 2 verification output.

## Rule evaluator state

Enabled rules in `execution_safety`, `capability_gap`, or `cache_safety` fail closed because those families have no deterministic evaluator. Evidence: `TestEnabledCacheSafetyRuleFailsClosedWithRuleAndFamily` and `TestEnabledRulesWithoutEvaluatorListsExactlyUnimplementedFamilies`.

Registries containing only implemented rule families retain the validation happy path. Evidence: `TestImplementedRuleFamiliesRetainHappyPath`.

## Invariant status

| Invariant | Status | Test evidence |
|---|---|---|
| G1: every production dispatch is mediated | ENFORCED | `TestRunnerRejectsMissingOrMismatchedValidationTokenWithoutExecution`; `TestMCPClientZeroValueCapabilityMakesNoHTTPRequest`; `TestMCPClientMutatedParametersFailHashWithoutHTTPRequest`; `TestExperimentGateOffRejectsRealMCPToolRegistry` |
| G2: resolved-value governance at dispatch | PARTIAL | `TestDeferredThresholdDispatch`; `TestResolvedSensitiveKeyAbortsBeforeTool`; `TestDeferredRequiredParameterRevalidatedAtDispatch`; no test proves dispatch-time separation-of-duties or approval-lifecycle enforcement |
| G3: idempotent side effects | NOT ENFORCED | No proving test exists |
| G4: recorded approval lifecycle | NOT ENFORCED | No proving test exists |
| G5: complete, tamper-resistant provenance | NOT ENFORCED | No proving test exists |

The detailed boundaries are maintained in `docs/INVARIANTS.md`.

## Consolidated experiment result

The frozen 120-case replay experiment contains 60 safe and 60 unsafe synthetic artifacts. With `GLOBAL-SOD-001` disabled, gate-on produced TP=54, FP=0, TN=60, and FN=6. With the same code, inputs, and gate but `GLOBAL-SOD-001` enabled, gate-on produced TP=60, FP=0, TN=60, and FN=0. The six changed cases are `unsafe_separation_of_duties_01` through `_06`. Evidence: `.audit-experiment-results-day3a-sod-disabled/metrics.json`, `.audit-experiment-results-day3a-sod-enabled/metrics.json`, their per-case CSV files, and `docs/RESULTS.md`.

## Model-independence boundary

Model independence is structural, not a statistical sample. The deterministic gate produced `600/600` identical per-case verdicts across five runs, workflow model-provenance metadata did not alter validation outcomes, and the validator transitively imports neither synthesis nor model-provider packages. Evidence: `TestGateVerdictsAreDeterministicAcrossRepeatedRuns`, `TestGateVerdictIsInvariantToModelProvenance`, and `TestValidatorImportsNoModelOrSynthesisPackage`.

## Future work

- G3: carry a stable idempotency key through retry and external dispatch and prove duplicate effects cannot occur after ambiguous failure.
- G4 runtime approval: add a durable approval record, suspend/resume execution, and enforce approval by a principal distinct from the requester.
- G5: bind complete model, prompt, policy, and registry provenance into append-only, tamper-resistant evidence.
- Smart Dispatcher: the component specified in `CLAUDE.md` is **NOT IMPLEMENTED**; existing hard-coded orchestration branches are not an extensible dispatcher, intent schema, or route registry.
- Multi-model generation study: specified but not run. The dataset labels the workflow artifact, not the instruction. A model receiving an unsafe instruction that emits a safe workflow would be scored as a gate false negative, conflating model refusal behaviour with gate recall. Sound execution requires independent labelling of every generated artifact. The study measures generation quality, not enforcement; enforcement invariance is established structurally.
