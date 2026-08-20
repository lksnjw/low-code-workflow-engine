# Risk register

| # | Severity | Finding | Evidence | Impact | Fix size |
|---:|---|---|---|---|---|
| 1 | CRITICAL | Tested Baseline B bypass is wired into the production server binary | `backend/internal/api/handlers/gate_invariant_test.go:215-237`; `backend/cmd/server/main.go:170-173` | Full-gate rejection can still reach ERP | M |
| 2 | CRITICAL | High-risk approval is an action-name check, not a pause/recorded distinct-principal decision | `backend/internal/core/validator/registry_validator.go:353-375`; `backend/internal/core/validator/registry_validator.go:898-905`; `backend/internal/core/runner/executor.go:95-194` | High-risk writes execute without human approval | L |
| 3 | CRITICAL | Tool and MCP exported APIs accept no gate proof | `backend/internal/tools/tool_interface.go:5-9`; `backend/internal/tools/mcp_client.go:60-101` | Internal code path can dispatch directly | M |
| 4 | CRITICAL | Side-effecting calls and retry path have no backend idempotency key | `backend/internal/api/handlers/execute_handler.go:457-469`; `backend/internal/tools/mcp_client.go:69-83` | Duplicate ERP effects after retry/timeout | M |
| 5 | CRITICAL | G5 evidence is neither mandatory-durable nor complete; policy/model versions are absent | `backend/internal/core/validator/registry_validator.go:1042-1065`; `backend/internal/config/config.go:127-130`; `backend/internal/storage/storage.go:19-29` | Decisions cannot always be reproduced or defended | M |
| 6 | HIGH | Dispatch performs only deferred-rule revalidation, not the full gate | `backend/internal/core/validator/registry_validator.go:402-500` | Templated SOD and other policy values can escape | M |
| 7 | HIGH | Audit store is mutable map state; PostgreSQL is a replaceable encrypted blob | `backend/internal/repository/memory.go:54-59`; `backend/internal/repository/persistent_store.go:201-228`; `backend/internal/storage/postgres.go:97-113` | Audit evidence is overwritable, not tamper-evident | L |
| 8 | HIGH | No CI workflow runs build, tests, lint, or safety tests | `.github/workflows/sync-to-main-repo.yml:1-39` | Regressions do not gate merges | S |
| 9 | HIGH | Registry `cache_safety` and some rule families silently no-op as “prompt grounding” | `backend/internal/core/validator/registry_validator.go:242-266` | Enabled policy can appear enforced when it is not | M |
| 10 | MEDIUM | Retry body parse errors are ignored | `backend/internal/api/handlers/execute_handler.go:466-469` | Malformed input silently becomes empty input | S |
| 11 | MEDIUM | Server defaults to volatile memory outside production | `backend/internal/config/config.go:127-130`; `backend/internal/storage/storage.go:19-29` | Restart loses executions, approvals, chats, and audits | M |
| 12 | MEDIUM | Synthetic semantic backfill score `0.99` is presented as a score without measurement | `backend/internal/core/orchestrator/chat_orchestrator.go:276-303` | Research/retrieval metrics can be misleading | S |
| 13 | MEDIUM | Model/prompt hash/version is not recorded per invocation; usage is only logged | `backend/internal/core/synthesizer/ollama_client.go:83-102`; `backend/internal/core/synthesizer/ollama_client.go:115-132` | Runs are not fully reproducible | M |
| 14 | MEDIUM | MCP success response is trusted as any JSON object; no per-tool schema validation/version negotiation | `backend/internal/tools/mcp_client.go:89-101` | Malformed downstream data can corrupt state/next steps | M |
| 15 | MEDIUM | Cancellation endpoint is a STUB | `backend/internal/api/handlers/execute_handler.go:453-455` | Synchronous long-running work cannot be stopped | M |
| 16 | MEDIUM | No end-to-end browser tests; frontend tests use mocked transports/components | `frontend/src/components/workflows/WorkflowActions.test.jsx:29-62`; `frontend/src/components/canvas/WorkflowBuilderCanvas.test.jsx:44-74`; `frontend/jest.config.js:1-12` | UI/backend contract regressions remain possible | M |
| 17 | MEDIUM | Backend full suite is timing-flaky across handler tests | `docs/audit/2026-08-19/EVIDENCE/test_backend.txt:1-86`; `backend/internal/api/handlers/company_handler_test.go:41-57` | CI/research results are not repeatable under load | S |
| 18 | LOW | Duplicate/unused page modules exist outside the router map | `frontend/src/config/router.jsx:17-48`; `frontend/src/pages/workflows/WorkflowNewPage.jsx:1-3` | Maintenance ambiguity | S |

## Prioritized backlog

### 1. Critical safety

Remove gate-off behavior from the HTTP server binary; require an unforgeable gate capability at the only dispatch boundary; implement durable approval state with requester/approver separation; add end-to-end idempotency (`backend/cmd/server/main.go:170-173`, `backend/internal/tools/mcp_client.go:60-101`).

### 2. Core research contribution

Replay the full applicable policy set over resolved values and reject every enabled rule without an evaluator (`backend/internal/core/validator/registry_validator.go:402-500`, `backend/internal/core/validator/registry_validator.go:242-266`).

### 3. Research evidence and reproducibility

Persist model/provider version, prompt version/hash, registry content hash, policy version, measured usage, and separate gate/model latency per invocation (`backend/internal/core/validator/registry_validator.go:1042-1065`, `backend/internal/core/synthesizer/ollama_client.go:83-132`).

### 4. Integration

Add versioned MCP request/response schemas, idempotency headers, cancellation, and schema validation (`backend/internal/tools/mcp_client.go:69-101`).

### 5. Persistence

Use normalized append-only audit/approval tables with tenant keys and database constraints instead of one overwritable blob (`backend/internal/storage/postgres.go:97-113`, `backend/internal/repository/persistent_store.go:201-228`).

### 6. Testing

Add tests for G3/G4/G5, templated separation of duties, direct-dispatch prevention, crash/retry ambiguity, and CI gates (`.github/workflows/sync-to-main-repo.yml:1-39`).

### 7. Frontend usability

Expose pending approvals, approver identity, idempotency outcome, registry/policy/model evidence, and structured rule details (`frontend/src/config/router.jsx:52-89`, `frontend/src/components/canvas/panels/ValidationPanel.jsx:1-22`).

### 8. Documentation

Remove 100% safety and production-readiness language until the above invariants are demonstrated (`CURRENT_STATE.md:1-20`, `README.md:171-190`).
