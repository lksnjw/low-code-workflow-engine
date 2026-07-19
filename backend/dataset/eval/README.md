# Workflow Gate Evaluation Dataset

This folder contains 120 deterministic, offline evaluation cases generated from the real tool and rule registries. It is not loaded by the application runtime.

## Generate

From `backend/`:

```bash
go run ./cmd/generate-eval-dataset \
  -tool-registry ./configs/registries/all_tools_master_registry.json \
  -rule-registry ./configs/registries/all_rules_master_registry.json \
  -output ./dataset/eval
```

The fixed seed is `20260720`. The generator refuses to run if the real registries no longer contain the tools or rule IDs used by the dataset, validates all safe cases with `RegistryValidator`, checks each ordinary unsafe case against its expected failed rule, and probes deferred variable thresholds with `EvaluateResolvedStep`.

## Files and counts

- `safe_workflows.jsonl`: 60 expected-allow cases.
- `unsafe_workflows.jsonl`: 60 expected-block cases.

Both files use this schema (the last two fields supply evaluation context):

```json
{"id":"...","label":"safe|unsafe","violation_type":"...","yaml":"...","expected":"allow|block","expected_rule":"...","user_role":"...","input":{}}
```

| Violation family | Safe counterparts | Unsafe |
|---|---:|---:|
| `unknown_tool` | 10 | 10 |
| `over_threshold_literal` | 10 | 10 |
| `over_threshold_variable` | 10 | 10 |
| `rbac_violation` | 10 | 10 |
| `missing_approval` | 8 | 8 |
| `self_approval` | 6 | 6 |
| `credential_in_param` | 6 | 6 |
| **Total** | **60** | **60** |

Safe cases are hard-negative counterparts that pass the real gate: known tools, threshold boundary values of 99 or 100, permitted roles, independent requester/approver IDs, required approvals/audits, and non-secret reference fields.

Unsafe labels are policy ground truth. Unknown-tool, literal-threshold, RBAC, missing-approval, and credential cases are checked against the corresponding real failed rule. Variable-threshold YAML uses `{{input.amount}}`; the threshold rule is deferred during planning and the generator supplies an input above 100 to prove the real dispatch evaluator returns `PROC-THRESH-001`. The real global risk rule can independently reject the same no-approval purchase workflow during planning, which is useful cross-rule evidence rather than a fabricated pass token.

## Registry coverage finding

The current real rule registry has no enabled `separation_of_duties` rule, although the validator contains an evaluator for that rule type. Therefore the six `self_approval` unsafe rows use `expected_rule: "UNCONFIGURED-SEPARATION-OF-DUTIES"` and intentionally act as false-negative probes: the current gate allows them. They should remain ground-truth unsafe so evaluation recall exposes the missing configured rule rather than hiding it.

## Sanity test

```bash
go test ./dataset/eval -count=1 -v
```

The test parses every JSONL row, checks both minimum counts, verifies the exact unsafe breakdown, requires violation/rule labels, verifies the resolved over-threshold inputs, and rejects duplicate IDs.
