# Validation and Dispatch Invariants

Status date: 2026-08-20

## Model independence — STRUCTURAL GUARANTEE

Workflow safety decisions are independent of model weights by construction. The complete gate is deterministic Go: for fixed workflow YAML, user role, tool registry, and rule registry, it computes the same verdict, rule IDs, and errors. Model provenance may be carried in `WorkflowBlueprint.Metadata`, but the gate does not read that field. The decision computation imports no synthesis or model-provider package and makes no model or HTTP call; audit persistence occurs only after the verdict has been computed.

This boundary is enforced by three tests:

| Property | Proving test |
|---|---|
| All 120 frozen cases produce identical per-case gate-on verdicts and fired rule IDs across five in-process runs | `TestGateVerdictsAreDeterministicAcrossRepeatedRuns` |
| Adding `model_name`, `model_version`, and `provider` workflow metadata changes neither plan validation details nor the final gate-on verdict | `TestGateVerdictIsInvariantToModelProvenance` |
| The validator's transitive imports contain neither the synthesizer nor the model-provider interface package | `TestValidatorImportsNoModelOrSynthesisPackage` |

This is a structural guarantee, not a statistical sample of model outputs.

## G1 — ENFORCED in the production build

The default build contains no Baseline B setter, state field, audit branch, experiment entry point, or `EXPERIMENT_BASELINE` configuration read. The runner requires a signed validation token and passes a validator-minted capability through `Tool.Execute` to `MCPClient.Execute`. MCP checks capability usability, action equality, and the hash of the parameters actually being sent before any transport operation.

| Enforced property | Proving test |
|---|---|
| Handler and runner construction require a registry validator | `TestHandlerConstructorRejectsNilRegistryValidator`; `TestRunnerConstructorRejectsNilValidator` |
| Missing, forged, content-mismatched, and registry-mismatched validation tokens stop before execution | `TestRunnerRejectsMissingOrMismatchedValidationTokenWithoutExecution` |
| A zero dispatch capability is rejected without an HTTP request | `TestMCPClientZeroValueCapabilityMakesNoHTTPRequest` |
| Parameters changed after capability minting are rejected without an HTTP request | `TestMCPClientMutatedParametersFailHashWithoutHTTPRequest` |
| A capability bound to unchanged parameters reaches the MCP HTTP endpoint | `TestMCPClientRemoteModePostsToMiddleware` |
| Setting `EXPERIMENT_BASELINE` does not change production configuration | `TestProductionConfigIgnoresExperimentBaselineEnvironment` |
| Experiment gate-off refuses a real MCP-backed tool registry | `TestExperimentGateOffRejectsRealMCPToolRegistry` |
| Experiment gate-off remains usable with spy tools | `TestBaselineBExecutesDispatchViolationAndAuditsBypass`; `TestBaselineBHandlerExecutesPlanBlockedWorkflowAndAuditsBypass` |

The build-tag and production-binary symbol/string checks are command evidence, not unit-test claims; they are recorded with the Day 2 delivery output.

## G2 — PARTIAL

The dispatch evaluator rechecks deferred numeric thresholds, required parameters, and sensitive-key conditions against resolved values. Families with no evaluator fail closed. This is not the complete governance gate: dispatch-time separation-of-duties and an approval lifecycle are not enforced.

| Enforced subset | Proving test |
|---|---|
| Literal over-threshold values fail at plan validation | `TestLiteralOverThresholdRejectedAtPlanTime` |
| Resolved threshold values are checked before the tool | `TestDeferredThresholdDispatch` |
| Resolved required parameters are checked before the tool | `TestDeferredRequiredParameterRevalidatedAtDispatch` |
| Resolved credential-like keys stop before the tool | `TestResolvedSensitiveKeyAbortsBeforeTool` |
| A deferred check with no evaluator stops before the tool | `TestDeferredCheckWithoutEvaluatorFailsClosed` |
| Enabled `cache_safety` fails with its rule ID and family | `TestEnabledCacheSafetyRuleFailsClosedWithRuleAndFamily` |

No test proves dispatch-time separation-of-duties or approval-lifecycle enforcement, so G2 is not stated more strongly.

## G3 — NOT ENFORCED

There is no proving test for an idempotency key carried through retry and external dispatch. Duplicate external effects after an ambiguous failure remain outside the enforced contract.

## G4 — NOT ENFORCED

There is no proving test for a persisted pause/approve/resume lifecycle or approval by a distinct principal. Approval-named workflow steps are not evidence of human approval.

## G5 — NOT ENFORCED

There is no proving test for complete model/policy provenance in an append-only, tamper-resistant audit record.

## Baseline B research artifact

Baseline B is retained only in files guarded by `//go:build experiment`. It compares gate-on decisions with gate-off would-execute decisions and emits the existing CSV/JSON formats. Gate-off may use only tools implementing the experiment spy/no-op marker; it cannot be enabled with a real MCP-backed tool. Evidence: `TestExperimentHarnessProducesCSVAndMetricsForFourCases`, `TestBaselineBExecutesDispatchViolationAndAuditsBypass`, and `TestExperimentGateOffRejectsRealMCPToolRegistry`.

The production `cmd/server` does not read `EXPERIMENT_BASELINE` and does not call an experiment bypass setter. Evidence: `TestProductionConfigIgnoresExperimentBaselineEnvironment` plus the production-binary symbol/string check recorded in the Day 2 delivery output.

## Future work

- **G3 idempotency:** carry a stable idempotency key through retries and external dispatch and prove that ambiguous failures cannot duplicate side effects.
- **G4 runtime approval:** persist an approval record, suspend and resume execution around the decision, and require an approver principal distinct from the requester.
- **G5 provenance:** bind model, prompt, policy, registry, and decision provenance into append-only, tamper-resistant evidence.
- **Smart Dispatcher:** the component specified in `CLAUDE.md` is **NOT IMPLEMENTED**. Existing hard-coded orchestration branches do not constitute the specified extensible dispatcher, intent schema, or route registry.
- **Multi-model generation quality:** specified but not run for the reason below.

### Multi-model generation-quality study

The current 120-case experiment harness is REPLAY: each case already contains workflow YAML, and that artifact is passed directly to the gate. It does not invoke a model.

A multi-model generation-quality comparison requires prompt-level ground truth. The current dataset labels the workflow artifact, not the instruction; a model that receives an unsafe instruction and emits a safe workflow would be scored as a gate false negative, conflating model refusal behaviour with gate recall. Sound execution requires independent labelling of every generated artifact. The study measures generation quality, not enforcement, and enforcement invariance is established structurally above.

The study is specified but not run. A sound GENERATE mode requires frozen natural-language instructions for every case, one generated artifact per model/run/case reused unchanged across gate-on and gate-off, and explicit failure rows for timeouts, refusals, empty responses, and malformed outputs without retries or fixture substitution.
