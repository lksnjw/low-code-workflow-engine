# Documentation drift

| Document | Claim | Reality | Evidence | Severity |
|---|---|---|---|---|
| `CURRENT_STATE.md` | “Safety invariants DONE (100%); no validator/dispatch bypass” | Baseline B bypasses both and is tested/wired into server | `CURRENT_STATE.md:15-20`; `backend/internal/api/handlers/gate_invariant_test.go:215-237`; `backend/cmd/server/main.go:170-173` | HIGH |
| `docs/INVARIANTS.md` | G1 “cannot be bypassed” | Same document later describes gate failures not enforced; server can use this mode | `docs/INVARIANTS.md:3-7`; `docs/INVARIANTS.md:40-44`; `backend/cmd/server/main.go:170-173` | HIGH |
| `README.md` | High-risk/RBAC/audit controls form a safer executable pipeline | Approval lifecycle is explicitly a future enhancement and current check is only action presence | `README.md:191-210`; `README.md:347-349`; `backend/internal/core/validator/registry_validator.go:364-375` | HIGH |
| `README.md` | Backend coordinates a “complete workflow intelligence pipeline” | Cancellation is STUB; approval/idempotency/G5 are absent | `README.md:124-143`; `backend/internal/api/handlers/execute_handler.go:453-469`; `backend/internal/core/validator/registry_validator.go:1042-1065` | HIGH |
| `docs/INTEGRATION_CONTRACTS.md` | Switching mock to real bridge is URL-only | Contract lacks schema/version/idempotency negotiation, so compatibility is not proven | `docs/INTEGRATION_CONTRACTS.md:5-8`; `backend/internal/tools/mcp_client.go:69-101` | MEDIUM |
| `CURRENT_STATE.md` | Core integration complete | Same document admits six gate-on self-approval false negatives | `CURRENT_STATE.md:15-23`; `CURRENT_STATE.md:74-80` | HIGH |
| `FINAL_STATUS.md` | G1/G2 are DONE | It also states Baseline B bypasses safety and retry safety is unimplemented | `FINAL_STATUS.md:5-14`; `FINAL_STATUS.md:29-32`; `FINAL_STATUS.md:48-50` | HIGH |
| `docs/ARCHITECTURE_MAP.md` | `POST /workflows/:id/run` failure represented in returned execution with HTTP 200 | Current handler returns HTTP 422 for failed executions | `docs/ARCHITECTURE_MAP.md:145`; `backend/internal/api/handlers/execute_handler.go:167-175` | MEDIUM |
| `docs/ARCHITECTURE_MAP.md` | Process crash has no startup recovery | Current server reconciles orphaned RUNNING executions | `docs/ARCHITECTURE_MAP.md:1423-1426`; `backend/cmd/server/main.go:101-104` | LOW |
| `CURRENT_STATE.md` | Historical frontend counts 9 suites/12 tests | Current run has 22 suites/43 tests; document is stale | `CURRENT_STATE.md:15-18`; `docs/audit/2026-08-19/EVIDENCE/test_frontend.txt:1-10` | LOW |

