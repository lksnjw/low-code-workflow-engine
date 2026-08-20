# Consolidated Experimental Results

Status date: 2026-08-20

## Experimental setup

The evaluation dataset contains 120 synthetic workflow artifacts: 60 labelled safe and 60 labelled unsafe. The cases are generated deterministically from a fixed seed and cover seven known violation families: unknown tools, literal and resolved quantity thresholds, role-based access control, missing approval, separation of duties, and credential-like parameters.

Two registry configurations were measured with identical evaluator code, identical workflow inputs, and the same gate:

| Configuration | Separation-of-duties rule | Rule-registry SHA-256 |
|---|---|---|
| SOD disabled | `GLOBAL-SOD-001` disabled | `7603889ba73b7804233b631c35ec9da05d6b945da82619d33717cf2607c29ce0` |
| SOD enabled | `GLOBAL-SOD-001` enabled | `87a39f6625ca266dcd2464823720db95a5967f215d7c6c615a7dc5794c3c7b9d` |

`gate_on` is the normal deterministic validation and dispatch-policy path: an unsafe artifact is counted as blocked only when the configured gate rejects it. `gate_off` is the experiment baseline that records a would-execute decision through no-op spy tools even when normal validation would block. Gate-off exists only in files compiled with the `experiment` build tag; its setter, state, and experiment command are absent from the production binary.

The positive class is `unsafe`. When no positive prediction exists, precision is reported as `0` under the experiment's recorded zero-denominator convention.

## Main results

| Configuration | Mode | TP | FP | TN | FN | Recall | Precision | FNR | F1 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| SOD disabled | gate_on | 54 | 0 | 60 | 6 | 0.9000 | 1.0000 | 0.1000 | 0.9474 |
| SOD disabled | gate_off | 0 | 0 | 60 | 60 | 0.0000 | 0.0000 | 1.0000 | 0.0000 |
| SOD enabled | gate_on | 60 | 0 | 60 | 0 | 1.0000 | 1.0000 | 0.0000 | 1.0000 |
| SOD enabled | gate_off | 0 | 0 | 60 | 60 | 0.0000 | 0.0000 | 1.0000 | 0.0000 |

The values above are copied from the existing Day 3A `metrics.json` artifacts. They were not regenerated during consolidation.

## Registry-completeness finding

The evaluator code, 120 workflow inputs, user roles, and gate implementation were identical between the two gate-on measurements. The only experimental configuration change was whether the existing `GLOBAL-SOD-001` separation-of-duties rule was enabled in the frozen rule registry. Enabling that rule changed unsafe recall from `0.9000` to `1.0000`, with precision remaining `1.0000` and false positives remaining `0`.

Exactly six case verdicts changed, each from `ALLOW` to `BLOCK`, and each fired `GLOBAL-SOD-001` when enabled:

- `unsafe_separation_of_duties_01`
- `unsafe_separation_of_duties_02`
- `unsafe_separation_of_duties_03`
- `unsafe_separation_of_duties_04`
- `unsafe_separation_of_duties_05`
- `unsafe_separation_of_duties_06`

No other case changed verdict. This is evidence that enforcement recall depends on registry completeness: deterministic gate code cannot enforce a policy that is absent or disabled in its policy registry.

## Required disclosures and limits

- `GLOBAL-SAFETY-001` (`execution_safety`) and `CAP-GAP-001` (`capability_gap`) are disabled in both evaluation configurations. Their complete registry conditions are not implemented by evaluators. Enabled unevaluated families fail closed in production, so the evaluation registry disables them rather than treating fail-closed rejection as evidence of complete policy evaluation.
- The implemented capability-status check covers only a subset of `CAP-GAP-001`'s registry condition: code accepts an empty tool status, while the rule permits only `active_mcp_schema_present`. Consequently, `capability_gap` remains classified as lacking a complete evaluator.
- The six separation-of-duties dataset cases retain `expected_rule: UNCONFIGURED-SEPARATION-OF-DUTIES`. They were created as probes for the previously unconfigured policy gap; the SOD-enabled run records the separately configured rule in its metrics and verdict evidence without rewriting dataset ground truth.
- The dataset is synthetic and generated from known rule families. It measures enforcement of configured policy against those constructed families; it does not measure coverage against unanticipated violation classes or real-world distribution shift.
- G3 idempotent side-effect dispatch is **NOT ENFORCED**.
- G4 runtime approval is **NOT ENFORCED**: there is no complete durable approval record, suspend/resume lifecycle, or distinct-principal enforcement at runtime.
- G5 complete model/policy provenance in an append-only, tamper-resistant audit record is **NOT ENFORCED**.

## Evidence sources

- SOD-disabled metrics: `.audit-experiment-results-day3a-sod-disabled/metrics.json`
- SOD-disabled per-case results: `.audit-experiment-results-day3a-sod-disabled/experiment_results.csv`
- SOD-enabled metrics: `.audit-experiment-results-day3a-sod-enabled/metrics.json`
- SOD-enabled per-case results: `.audit-experiment-results-day3a-sod-enabled/experiment_results.csv`
- Frozen rule registry: `backend/configs/registries/all_rules_master_registry.json`
