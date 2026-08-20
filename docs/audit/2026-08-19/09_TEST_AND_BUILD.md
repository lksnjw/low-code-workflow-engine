# Test and build

| Command | Result | Raw evidence |
|---|---|---|
| `go build -buildvcs=false ./...` | PASS, exit 0 | `EVIDENCE/build_backend.txt` (successful Go build emits no output) |
| `go test ./... -count=1` | **FAIL / FLAKY**: an initial full run passed, but two captured repeats failed on different Fiber 1-second handler timeouts; the first isolated failing test then passed 10/10 | `EVIDENCE/test_backend.txt` |
| `npm run build` | PASS after an initial sandbox filesystem failure; Vite 7.3.6 built 2,173 modules | `EVIDENCE/build_frontend.txt` |
| `npm test -- --runInBand` | PASS: 22 suites, 43 tests | `EVIDENCE/test_frontend.txt` |
| `npm run lint` | PASS | `EVIDENCE/lint.txt` |

The backend suite includes unit, handler/API, middleware, repository/storage, mock-ERP, and integration packages (`docs/audit/2026-08-19/EVIDENCE/test_backend.txt:1-86`). The safety-significant test code asserts normal token enforcement, resolved threshold blocking, policy-not-healing, strict YAML, registry-hash invalidation, and the Baseline B bypass (`backend/internal/api/handlers/gate_invariant_test.go:44-271`, `backend/internal/api/handlers/registry_bulk_import_test.go:185-224`, `backend/tests/unit/runner_test.go:180-279`).

Tests that primarily prove configured fakes/mocks returned or received configured values include the mock MCP echo test, provider HTTP-fixture usage tests, the sequenced mock-Gemini generation-accuracy test, and frontend component service-call tests (`backend/internal/tools/mcp_client_test.go:29-57`, `backend/internal/core/synthesizer/usage_test.go:13-183`, `backend/tests/unit/semantic_and_generation_accuracy_test.go:118-166`, `frontend/src/components/workflows/WorkflowActions.test.jsx:29-62`, `frontend/src/components/users/UserForm.test.jsx:22-55`). They are useful adapter/component tests but not evidence that a real ERP or live provider works.

Flakiness is confirmed: one full run passed, a repeat timed out `TestCompanyProfileRejectsInvalidTimezoneAndCurrency`, that test passed 10 repeated isolated runs, and a third full run timed out four different registry handler tests (`docs/audit/2026-08-19/EVIDENCE/test_backend.txt:1-86`, `backend/internal/api/handlers/company_handler_test.go:41-57`, `backend/internal/api/handlers/registry_bulk_import_test.go:26-224`). Coverage is `UNDETERMINED` because repository scripts do not enable coverage and no coverage-writing command was run, preserving the audit-only-write constraint (`frontend/package.json:6-10`, `backend/Makefile:1-20`).

Completely untested or insufficiently tested by safety impact: real approval pause/resume and distinct-principal authorization (NOT FOUND), idempotent retry (NOT FOUND), immutable/durable G5 evidence, prevention of direct internal MCP calls, full dispatch replay for templated SOD, live PostgreSQL in the current run, real external MCP compatibility, and browser E2E (`backend/internal/api/routes/routes.go:130-136`, `backend/internal/tools/mcp_client.go:60-101`, `frontend/package.json:6-10`).

CI does not gate build/test/lint. The sole workflow performs a subtree sync on selected pushes and contains no verification job (`.github/workflows/sync-to-main-repo.yml:1-39`).
