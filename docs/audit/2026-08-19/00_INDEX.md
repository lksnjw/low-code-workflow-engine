# Forensic audit index

Date: 2026-08-19 (`docs/audit/2026-08-19/EVIDENCE/git_log.txt:1-8`)  
Commit: `59704f70fdf327b7680eeaadbd8b1bf0dd83d504` (`docs/audit/2026-08-19/EVIDENCE/git_log.txt:1-8`)  
Branch: `fix/workflow-output-display` (`docs/audit/2026-08-19/EVIDENCE/git_log.txt:1-8`)  
Initial tree: dirty because pre-existing `.claude/` was untracked; the audit then added only `docs/audit/2026-08-19` (`FINAL_STATUS.md:5-5`, `docs/audit/2026-08-19/EVIDENCE/git_log.txt:1-8`).

**Verdict: No — the core research claim does not hold because a tested server configuration deliberately bypasses plan and dispatch rejection, and approval, idempotency, and complete durable audit invariants are not enforced (`backend/internal/api/handlers/gate_invariant_test.go:215-237`, `backend/internal/core/validator/registry_validator.go:898-905`, `backend/internal/tools/mcp_client.go:69-83`, `backend/internal/core/validator/registry_validator.go:1042-1065`).**

## Five most serious findings

| Rank | Finding | Detail |
|---:|---|---|
| 1 | Baseline B is a tested gate bypass wired into the HTTP server (`backend/cmd/server/main.go:170-173`). | [Gate bypass](03_GATE_BYPASS_ANALYSIS.md) |
| 2 | High-risk approval is only an approval-like step name; execution never pauses for another principal (`backend/internal/core/validator/registry_validator.go:898-905`). | [Safety invariants](02_SAFETY_INVARIANTS.md) |
| 3 | Backend tool/MCP APIs accept no validation capability and can be called directly (`backend/internal/tools/mcp_client.go:60-101`). | [Gate bypass](03_GATE_BYPASS_ANALYSIS.md) |
| 4 | Retry/MCP dispatch has no enforced idempotency key (`backend/internal/api/handlers/execute_handler.go:457-469`). | [Risk register](10_RISK_REGISTER.md) |
| 5 | Gate evidence is optional-durable and lacks policy/model versions (`backend/internal/core/validator/registry_validator.go:1042-1065`). | [Data and persistence](07_DATA_AND_PERSISTENCE.md) |

## Build and test

Backend build: PASS. Backend tests: **FAIL / FLAKY** (one earlier pass; two captured full-run failures on varying 1-second handler timeouts; isolated test passed 10/10). Frontend build: PASS after sandbox filesystem failure. Frontend tests: PASS (22/22 suites, 43/43 tests). Lint: PASS (`docs/audit/2026-08-19/EVIDENCE/test_backend.txt:1-86`, `docs/audit/2026-08-19/EVIDENCE/build_frontend.txt:1-80`, `docs/audit/2026-08-19/EVIDENCE/test_frontend.txt:1-10`, `docs/audit/2026-08-19/EVIDENCE/lint.txt:1-4`).

## Completion assessment

Percentages measure reachable, working, test-backed behavior against the subsystem's required behavior, not file or route counts.

| Subsystem | Completion | Basis |
|---|---:|---|
| Deterministic plan validation | 70% | Substantial full-gate logic/tests, but bypass mode and silent rule no-ops (`backend/internal/core/validator/registry_validator.go:77-203`, `backend/internal/core/validator/registry_validator.go:242-266`). |
| Runtime dispatch safety | 35% | Token and selected deferred checks work; no universal dispatch capability, full replay, approval, or idempotency (`backend/internal/core/runner/executor.go:62-171`). |
| Runner/healing | 65% | Sequential terminal behavior and bounded repair work; cancel is STUB and retry unsafe (`backend/internal/api/handlers/execute_handler.go:95-175`, `backend/internal/api/handlers/execute_handler.go:453-469`). |
| Persistence/audit | 50% | Encrypted snapshot is real but optional, mutable, single-writer, and missing provenance (`backend/internal/repository/persistent_store.go:201-228`). |
| Integrations | 45% | Real HTTP adapters and mock ERP; no live compatibility evidence/schema/version/idempotency (`backend/internal/tools/mcp_client.go:60-101`). |
| Backend product APIs | 72% | Broad reachable/tested CRUD/RBAC; some prototype/STUB behavior and no CI gate (`backend/internal/api/routes/routes.go:13-214`). |
| Frontend | 75% | Real routed API UI and passing tests/build; no live WebSocket/E2E or approval evidence UI (`frontend/src/config/router.jsx:52-89`). |
| Research evidence | 45% | Reproducible experiment harness exists, but known false negatives and incomplete provenance/baselines remain (`backend/dataset/eval/experiment.go:28-98`). |

**Overall production readiness: 38%.** Basis: the product surface builds and much CRUD works, but production readiness is capped by four CRITICAL side-effect safety failures and incomplete durable evidence; a system that can bypass the gate cannot receive a majority readiness score for this thesis (`docs/audit/2026-08-19/10_RISK_REGISTER.md:3-20`).

## Reports

- [Inventory](01_INVENTORY.md)
- [Safety invariants](02_SAFETY_INVARIANTS.md)
- [Gate bypass analysis](03_GATE_BYPASS_ANALYSIS.md)
- [Backend audit](04_BACKEND_AUDIT.md)
- [Frontend audit](05_FRONTEND_AUDIT.md)
- [Integration contracts](06_INTEGRATION_CONTRACTS.md)
- [Data and persistence](07_DATA_AND_PERSISTENCE.md)
- [Research evidence](08_RESEARCH_EVIDENCE.md)
- [Test and build](09_TEST_AND_BUILD.md)
- [Risk register](10_RISK_REGISTER.md)
- [Thesis defensibility](11_THESIS_DEFENSIBILITY.md)
- [Documentation drift](12_DOC_DRIFT.md)

## Undetermined

Semantic-search service startup, live PostgreSQL behavior, real external MCP/LLM compatibility, dependency unused/unmaintained status, repeated-run flakiness, code coverage, and dataset train/test separation remain `UNDETERMINED`; resolving them requires the corresponding services/credentials, a live database/bridge, dependency metadata analysis, repeated/coverage runs, and a declared split manifest (`backend/semantic_search_service/README.md:1-53`, `backend/internal/storage/postgres.go:36-77`, `backend/internal/tools/mcp_client.go:60-101`).
