# Workflow Generation Accuracy

Measured on 2026-08-02 with the runtime registry, the active Gemini `gemini-2.5-flash` provider, one candidate per request, 10 retrieved tools, 15 retrieved rules, 5 templates, and 3 examples. Token values below are provider-reported input-token counts; no locally estimated token values are included.

## Result

| Prompt version | Intended requests | Provider responses | First-pass gate passes | Passes after repair | Unresolved candidates | Average measured input tokens |
|---|---:|---:|---:|---:|---:|---:|
| Before | 20 | 16 | 14/16 (87.50%) | 0 | 2/16 | 3,790.75 |
| After | 20 | 0 | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED |

The before run reported 60,652 total input tokens across 16 completed provider responses. Four requests returned HTTP 502 before producing a candidate. Retrying those same four requests returned HTTP 502 again.

The post-change backend was started separately on port 8081 against the same runtime registry and provider configuration. Its first fixed-corpus request returned HTTP 502 before producing a candidate. The remaining 19 requests were not sent because another result would not provide a measured generation or token value. Therefore this run does not establish an after accuracy or token result, and no improvement is claimed.

## Before-run evidence

| Case | First-pass gate pass | Provider input tokens |
|---|---:|---:|
| GEN01 | yes | 3,956 |
| GEN02 | yes | 4,122 |
| GEN03 | yes | 3,428 |
| GEN04 | yes | 3,441 |
| GEN05 | yes | 3,967 |
| GEN06 | yes | 3,779 |
| GEN07 | yes | 3,886 |
| GEN08 | yes | 3,901 |
| GEN09 | yes | 3,909 |
| GEN10 | yes | 4,119 |
| GEN11 | no | 3,900 |
| GEN12 | no | 4,144 |
| GEN13 | yes | 3,403 |
| GEN14 | yes | 2,852 |
| GEN15 | yes | 3,892 |
| GEN16 | provider HTTP 502 | — |
| GEN17 | provider HTTP 502 | — |
| GEN18 | provider HTTP 502 | — |
| GEN19 | yes | 3,953 |
| GEN20 | provider HTTP 502 | — |

The before implementation did not perform validator-guided regeneration, so its after-repair count is zero.

## Fixed request corpus

1. Create a manual workflow that echoes input message and amount using `demo.echo`.
2. Classify invoice `INV-1001`, then notify finance with classification result.
3. Fetch attendance `EMP-1001` for `2026-08-01`.
4. Create annual leave for `EMP-1002` from `2026-08-10` to `2026-08-12`.
5. Refresh connector `finance-primary`.
6. Send a webhook notification callback saying invoice processed.
7. Validate vendor `V-1007`.
8. Validate `V-1008` and create a purchase order for `ITEM-1008`, quantity 50.
9. Validate `V-1009` and create a purchase order for `ITEM-1009`, quantity 150, with approval and audit.
10. Record invoice receipt `INV-1010` and audit it.
11. Record goods receipt `PO-1011`, item `ITEM-1011`, quantity 20.
12. Record invoice receipt `INV-1012`, record goods receipt `PO-1012` for `ITEM-1012`, quantity 10, clear it, and notify finance.
13. Create a shipment for order `ORD-1013`, then retrieve it.
14. Check the policy limit for a purchase quantity of 80.
15. Request human approval from a manager for `PO-1015`.
16. Write an audit log for workflow `WF-1016` with actor Platform Admin and decision approved.
17. Create a capability request for vendor-ledger automation.
18. Generate runtime registry context using the registered demo context tool.
19. Import a demo registry payload using the registered demo registry import tool.
20. Build a finance exception workflow that classifies `INV-1020`, checks policy, notifies finance, sends a webhook, and writes an audit log.

The executable check is `TestGenerationFirstPassAccuracy20`. It is opt-in because it calls a real provider. It fails if any provider request fails or if provider-reported token metadata is absent, and it logs first-pass, repaired, unresolved, and average measured input-token results for all 20 requests.

## Safety regression

The frozen 120-case experiment remained unchanged after the implementation:

```text
gate_on   TP 54  FP 0  TN 60  FN 6   recall 0.9000  precision 1.0000
gate_off  TP 0   FP 0  TN 60  FN 60  recall 0.0000  precision 0.0000
```
