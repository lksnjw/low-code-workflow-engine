# Codebase Audit Report

Audit target: repository root containing `backend/`, `frontend/`, `datasets/`, and `docs/`. Audit date: 2026-07-16.

## 1. Executive summary

1. This is an enterprise-style low-code workflow prototype that retrieves ERP tools/rules, asks Gemini for YAML candidates, validates them deterministically, and renders selected YAML in a React Flow canvas (`README.md:9-17`, `README.md:89-103`).
2. Honest overall completion estimate: **43%**; the retrieval/generation/validator core is substantive, but persistence, production auth, retries, approvals, most UI data, and integrations remain prototype-grade (`backend/internal/core/orchestrator/chat_orchestrator.go:30-166`, `backend/internal/repository/memory.go:13-35`, `frontend/src/constants/mockData.js:3-243`).
3. Biggest gap 1: PostgreSQL and Redis are never connected; every application record is process-local memory (`backend/internal/config/db.go:11-19`, `backend/internal/config/redis.go:11-19`, `backend/internal/repository/memory.go:13-35`).
4. Biggest gap 2: auth accepts any password and maps an unknown email to the seeded admin; route-level permission middleware exists but is never applied (`backend/internal/api/handlers/auth_handler.go:11-53`, `backend/internal/api/middlewares/rbac.go:8-16`, `backend/internal/api/routes/routes.go:27-153`).
5. Biggest gap 3: the runner ignores `condition`, `onError`, `retryCount`, and idempotency, while self-healing repairs YAML only after side effects may already have occurred (`backend/internal/core/runner/executor.go:45-87`, `backend/internal/models/state.go:54-58`, `backend/internal/core/healing/error_loop.go:16-51`).
6. Backend and frontend production builds succeed; Go vet succeeds; frontend lint fails with 2 errors and 1 warning (verification in section 3; build configuration at `backend/Makefile:3-13`, `frontend/package.json:6-10`).
7. The isolated Go suite passes **22 tests with 1 skipped live-Gemini test**; a clean concurrent run exposed a report-directory ordering defect (`backend/tests/unit/semantic_and_generation_accuracy_test.go:93-110`, `backend/tests/unit/semantic_and_generation_accuracy_test.go:178-185`, `backend/tests/unit/semantic_and_generation_accuracy_test.go:725-739`).
8. The Go API server starts and listens, but chat requires the external semantic service and Gemini; MCP execution is a deterministic mock while `MCP_BASE_URL` is empty (`backend/internal/config/config.go:91-106`, `backend/internal/tools/mcp_client.go:24-32`).
9. A real Gemini key is configured in ignored `backend/.env.development`; its value is **[REDACTED]** and was not copied into this report (`backend/internal/config/config.go:54-60`, `.gitignore:1-6`).

## 2. Repository map

```text
.
|-- .github/
|   `-- workflows/                 Repository synchronization workflow
|-- backend/                       Go API plus Python semantic-search service
|   |-- cmd/server/                Fiber process entry point
|   |-- configs/registries/        Compact runtime tool/rule registries
|   |-- dataset/                   Large ERP tools, rules, templates, scenarios, validator cases
|   |-- docs/                      Backend design notes (not authoritative over code)
|   |-- internal/
|   |   |-- api/                   Fiber handlers, middleware, routes
|   |   |-- config/                Environment loading; memory DB/Redis adapters
|   |   |-- core/                  orchestrator, registry, validator, retrieval, synthesis, runner, healing
|   |   |-- models/                API and in-memory record structs
|   |   |-- repository/            Seeded in-memory store
|   |   `-- tools/                 Tool interface, registry, MCP HTTP client
|   |-- pkg/                       Logger and YAML/variable helpers
|   |-- semantic_search_service/   FastAPI + FAISS + Ollama embeddings
|   `-- tests/                     Integration, unit, fixture, and mock tests
|-- datasets/
|   `-- semantic_validation/       Separate generated 5,000-record research dataset
|-- docs/
|   `-- api/                       Planned/consumer API documentation
|-- frontend/                      React/Vite application
|   |-- public/                    Static assets
|   `-- src/
|       |-- components/            Canvas, chat, dashboard, execution, settings, user UI
|       |-- context/, hooks/        Client state and data hooks
|       |-- pages/, layouts/        Application screens
|       |-- services/               Auth/chat live clients; most others mock data
|       |-- store/                  Zustand stores, mostly seeded
|       |-- tests/                  Placeholder Jest suites
|       `-- utils/                  YAML/canvas and formatting helpers
`-- modal/                         Research PDF artifact, not runtime code
```

Purpose evidence: backend wiring is in `backend/cmd/server/main.go:26-100`; core directories are imported at `backend/cmd/server/main.go:12-21`; frontend page routing is in `frontend/src/App.jsx:30-58`; semantic service endpoints are in `backend/semantic_search_service/app.py:127-255`; dataset loading is in `backend/internal/core/registry/loader.go:40-72`.

### Languages, frameworks, versions

| Area | Evidence-based stack |
|---|---|
| Backend | Go 1.22 module; Fiber 2.52.6, Fiber WebSocket 1.3.4, JWT v5.2.1, validator v10.22.0, Zap 1.27.0, YAML v3 (`backend/go.mod:1-13`). Audit host actually used Go 1.26.0. |
| Frontend | React 19.2, Vite declared `^7.2.4` (installed build reported 7.3.2), React Router 7.9.5, React Query 5.90.8, XYFlow 12.10.2, Zustand 5.0.8 (`frontend/package.json:12-42`). Audit host used Node 24.16.0 and npm 11.1.0. |
| Semantic service | Python/FastAPI 0.115.6, Uvicorn 0.32.1, FAISS CPU 1.9.0.post1, NumPy 2.1.3, Pydantic 2.10.4 (`backend/semantic_search_service/requirements.txt:1-5`). Audit host used Python 3.13.2. |
| Infrastructure | Docker images specify Go 1.22/Alpine 3.20, Node 22/Nginx 1.27, PostgreSQL 16, Redis 7 (`backend/Dockerfile:1-15`, `frontend/Dockerfile:1-12`, `backend/docker-compose.yml:1-29`). |

`CLAUDE.md`: **NOT FOUND** in the repository. `AGENTS.md`: **NOT FOUND** in this repository.

## 3. Build and test verification

All commands below were executed from this repository on 2026-07-16. Go commands used repository-local `.gocache` and `.gomodcache` after the sandbox denied the user-global Go cache.

### Builds

| Command | Real result |
|---|---|
| `cd backend; go build -buildvcs=false ./...` | **SUCCESS**, exit 0, no compiler output. The configured binary build is `go build -buildvcs=false -o bin/agentic-orchestrator ./cmd/server` (`backend/Makefile:8-9`). |
| `cd frontend; npm.cmd run build` | **SUCCESS**, 2,674 modules transformed in 24.13 s. Output: `index.html` 0.57 kB, CSS 76.73 kB, JS 936.78 kB (283.79 kB gzip). Vite warned that Axios is both statically and dynamically imported and that the JS chunk exceeds 500 kB. Script evidence: `frontend/package.json:6-10`. |
| `cd backend/semantic_search_service; .venv/Scripts/python.exe -m py_compile app.py` | **SUCCESS**, exit 0. |
| `cd backend/semantic_search_service; .venv/Scripts/python.exe -c "import app; print(app.app.title)"` | **SUCCESS**, printed `Workflow Dataset Semantic Search`; app definition is `backend/semantic_search_service/app.py:127-134`. |

### Tests

| Command | Real result |
|---|---|
| `cd backend; go test -count=1 ./...` (first clean/concurrent run) | **FAIL**: `TestSemanticSearchGeneratedAccuracyReport` could not write `backend/test-results/semantic_search_accuracy_report.json`: `The system cannot find the path specified.` The writer does not create the directory before its first write (`backend/tests/unit/semantic_and_generation_accuracy_test.go:725-739`); another writer does (`backend/tests/unit/validator_accuracy_test.go:210-236`). |
| Same Go command, isolated after the directory existed | **PASS**: all packages passed; JSON event count was **22 passed, 0 failed, 1 skipped**. The skip is the opt-in live Gemini test (`backend/tests/unit/semantic_and_generation_accuracy_test.go:178-185`). |
| `cd frontend; .\\node_modules\\.bin\\jest.cmd --runInBand` | **FAIL before collection**: `Test environment jest-environment-jsdom cannot be found.` Jest requests `jsdom` (`frontend/jest.config.js:1-6`) but `jest-environment-jsdom` is absent from dependencies (`frontend/package.json:26-42`). |

The test count must not be read as 22 production behaviors: four component suites and the workflow-builder integration suite are literal placeholder assertions (`frontend/src/tests/unit/components/ChatWindow.test.jsx:1-6`, `frontend/src/tests/unit/components/FlowCanvas.test.jsx:1-6`, `frontend/src/tests/unit/components/LoginForm.test.jsx:1-6`, `frontend/src/tests/integration/WorkflowBuilder.test.jsx:1-6`).

### Lint, vet, and coverage

| Command | Real result |
|---|---|
| `cd backend; go vet ./...` | **SUCCESS**, exit 0, no diagnostics. |
| `cd frontend; npm.cmd run lint` | **FAIL**, 2 errors and 1 warning: unused `useState` in `frontend/src/components/chat/ChatToolbar.jsx:1`; synchronous state reset in `frontend/src/hooks/useChat.js:18-22`; effect invokes state-updating `loadSessions` in `frontend/src/hooks/useChatSessions.js:55-58`. |
| `cd backend; go test -count=1 -cover ./...` | Command passed, but reported 0.0% for most production packages and 3.9% for `internal/core/orchestrator`; external tests under `tests/unit` were reported as `[no statements]`. A reliable aggregate production coverage percentage is therefore **NOT DETERMINABLE** from the configured layout. There is no coverage command in `backend/Makefile:3-17`. |

### Startup verification

The current Go server binary was built and run with `APP_HOST=127.0.0.1`, `APP_PORT=18082`, and secret-bearing log values replaced with `[REDACTED]`. It remained alive until the audit intentionally terminated it after 8.6 seconds. Real output summary:

```text
Agentic Workflow Engine | Fiber v2.52.6 | http://127.0.0.1:18082
Handlers: 182 | Processes: 1 | Prefork: Disabled
database adapter prepared {"mode":"memory","url":"[REDACTED]"}
redis adapter prepared {"mode":"memory","url":"[REDACTED]"}
agentic orchestrator backend listening {"addr":"127.0.0.1:18082","api":"/api"}
```

Startup works because database and Redis constructors do not connect (`backend/internal/config/db.go:11-19`, `backend/internal/config/redis.go:11-19`). The first chat request will fail unless the external embedding service at `SEMANTIC_SEARCH_URL` works because external retrieval is the default and lexical fallback defaults false (`backend/internal/config/config.go:96-102`, `backend/internal/core/semanticsearch/service.go:63-90`). Candidate generation then requires a working Gemini key/model (`backend/internal/core/synthesizer/gemini_client.go:33-104`). Workflow execution works structurally but returns deterministic mock tool results until `MCP_BASE_URL` is configured (`backend/internal/tools/mcp_client.go:24-32`).

## 4. Feature inventory

Status definitions are applied exactly as requested: **IMPLEMENTED**, **PARTIAL**, **MOCKED**, or **MISSING**.

| Feature/module | Status | Key evidence | Evidence / notes |
|---|---|---|---|
| Smart dispatcher (overall) | PARTIAL | `backend/internal/core/orchestrator/chat_orchestrator.go:30-166` | Hard-coded safety/capability/generation branches exist, but there is no general dispatcher type, intent schema, or extensible route registry. |
| Dispatcher route: destructive identity/admin request | IMPLEMENTED | `backend/internal/core/orchestrator/chat_orchestrator.go:57-69`, `:169-192` | Deterministically blocks destructive verbs paired with identity targets before generation. |
| Dispatcher route: no executable tools | IMPLEMENTED | `backend/internal/core/orchestrator/chat_orchestrator.go:71-100` | Routes to capability/schema generation or an executable capability-request tool. |
| Dispatcher route: generate/validate/select workflow | IMPLEMENTED | `backend/internal/core/orchestrator/chat_orchestrator.go:102-156` | Retrieves context, makes one multi-candidate LLM call, validates every candidate, selects a passing candidate. |
| Dispatcher route: regenerate/clarify | PARTIAL | `backend/internal/core/orchestrator/chat_orchestrator.go:157-166` | Returns `next_action`, but no automatic regeneration or structured clarification loop exists. |
| Workflow blueprint schema | IMPLEMENTED | `backend/internal/models/workflow.go:13-36`, `backend/internal/core/validator/schema_check.go:19-39` | Typed trigger/step schema plus YAML parse and struct validation. Conditions exist in the schema but execution ignores them. |
| Structural/schema gate | IMPLEMENTED | `backend/internal/core/validator/schema_check.go:19-39`, `backend/internal/core/validator/registry_validator.go:66-83` | Parse, required fields, minimum one step, and generated-description requirement. |
| Tool allowlist/status gate | IMPLEMENTED | `backend/internal/core/validator/registry_validator.go:85-127` | Unknown, mock-schema-missing, future, and unsupported-status tools fail. |
| Required-parameter gate | IMPLEMENTED | `backend/internal/core/validator/registry_validator.go:130-141`, `:191-208` | Checks tool required parameters and parameter rules. No deep JSON-schema type validation. |
| Authorization/RBAC gate | PARTIAL | `backend/internal/core/validator/registry_validator.go:143-149`, `:179-189` | Candidate role checks are real; API route authorization is not. Admin is an unconditional role override. |
| Policy threshold gate | PARTIAL | `backend/internal/core/validator/registry_validator.go:210-231`, `:526-548` | Literal numeric values are checked; runtime placeholders such as `{{input.amount}}` are not evaluated. |
| Process-order gate | IMPLEMENTED | `backend/internal/core/validator/registry_validator.go:233-249` | Enforces configured before/after pairs when the after action appears. |
| Separation-of-duties gate | PARTIAL | `backend/internal/core/validator/registry_validator.go:251-260` | Only compares `requester_id` and `approver_id` within each step. |
| Risk/approval gate | PARTIAL | `backend/internal/core/validator/registry_validator.go:262-274`, `:574-581` | Requires an approval-like action for high risk; there is no approval state machine or wait/resume. |
| Audit-presence gate | PARTIAL | `backend/internal/core/validator/registry_validator.go:276-288` | Requires the audit action name, not required audit fields, immutability, order, or successful delivery. |
| Credential/sensitive-input gate | IMPLEMENTED | `backend/internal/core/validator/registry_validator.go:103-106`, `:349-375` | Recursively rejects credential-like parameter keys. |
| Global execution/cache/confidentiality rules | PARTIAL | `backend/internal/core/validator/registry_validator.go:151-175` | Several rule types are explicitly not evaluated and exist only for prompt grounding/dedicated checks. |
| Execution engine | PARTIAL | `backend/internal/core/runner/executor.go:28-90` | Sequential tool execution and state substitution work; conditions, branching, retries, on-error policy, rollback, and resume do not. |
| MCP integration | MOCKED | `backend/internal/tools/mcp_client.go:24-63`, `backend/cmd/server/main.go:53-65` | HTTP bridge exists; empty base URL returns accepted mock results. This is not a full MCP protocol client/server implementation. |
| Self-healing/recovery controller | PARTIAL | `backend/internal/core/healing/error_loop.go:11-51`, `backend/internal/api/handlers/execute_handler.go:61-87` | One LLM repair can replace YAML after registry validation; it does not retry the failed execution. |
| HITL approval flow | MISSING | `backend/internal/core/validator/registry_validator.go:225-229`, `backend/internal/core/runner/executor.go:45-87` | Approval is only a validated tool step; no pending approval record, callback, pause, authorization, or resume path exists. |
| Frontend canvas editing | PARTIAL | `frontend/src/components/canvas/WorkflowBuilderCanvas.jsx:430-586` | Drag/drop/connect/render is real; run is a timed simulation and deploy is a `fitView` call. |
| YAML-to-canvas handoff | IMPLEMENTED | `frontend/src/components/chat/ChatArtifactPanel.jsx:287-298`, `frontend/src/utils/workflowCanvas.utils.js:38-158` | Passing a validated chat YAML through local storage into canvas works, using a limited handwritten YAML parser. |
| Canvas-to-YAML/backend deployment | MISSING | `backend/internal/api/handlers/catalog_handler.go:112-141`, `frontend/src/components/canvas/WorkflowBuilderCanvas.jsx:532-559` | Backend explicitly reports conversion not implemented; frontend backend calls are comments. |
| Authentication | MOCKED | `backend/internal/api/handlers/auth_handler.go:11-140`, `backend/internal/api/middlewares/auth.go:13-47` | JWT parsing/signing exists, but passwords, refresh-token validation/revocation, reset, verification, 2FA, and OAuth are fake/incomplete. |
| Roles and API authorization | PARTIAL | `backend/internal/api/middlewares/rbac.go:8-16`, `backend/internal/api/routes/routes.go:27-153` | Role/permission data and middleware exist; all protected routes use authentication only, never `RequirePermission`. |
| Audit logging | PARTIAL | `backend/internal/repository/memory.go:213-218`, `backend/internal/api/handlers/workflow_handler.go:57-60`, `:102-104` | Volatile audit records are written for workflow create/update only; sensitive admin, execution, settings, key, login, and delete actions are not comprehensively audited. |
| Policy/data retrieval | IMPLEMENTED | `backend/internal/core/semanticsearch/service.go:63-158`, `backend/semantic_search_service/app.py:223-255` | External embedding retrieval and explicit lexical fallback exist. Availability depends on the Python service/Ollama. |
| Embedding/index service | IMPLEMENTED | `backend/semantic_search_service/app.py:137-171`, `:269-352`, `:540-675` | FAISS indexing, Ollama or SentenceTransformer embeddings, fingerprinting, disk cache, search, and rebuild exist. SentenceTransformer is not declared in requirements. |
| Gemini workflow generation | PARTIAL | `backend/internal/core/synthesizer/gemini_client.go:21-104`, `backend/internal/core/synthesizer/candidates.go:37-54` | Real REST call exists; live test is opt-in/skipped, there is no retry/backoff, response schema mode, or true usage accounting. |
| Open-source workflow generation | MISSING | `backend/internal/core/synthesizer/ollama_client.go:78-87`, `:89-134` | Ollama generation client code exists but the active service rejects every non-Gemini generation provider. Ollama is active only for embeddings. |
| Token/context management | PARTIAL | `backend/internal/config/config.go:98-106`, `backend/internal/core/synthesizer/candidates.go:37-54`, `backend/internal/core/synthesizer/gemini_client.go:51-55` | Top-K and candidate caps plus 8,192 output-token cap exist; no input budget, truncation of LLM context, real token count, budget enforcement, or conversation context window exists. |
| Workflow CRUD/versioning | PARTIAL | `backend/internal/api/handlers/workflow_handler.go:13-320` | Volatile CRUD/version endpoints work. Publish/restore/use-template can store YAML without the full registry gate. |
| Dashboard and analytics | MOCKED | `backend/internal/api/handlers/dashboard_handler.go:11-54`, `backend/internal/api/handlers/analytics_handler.go:10-79` | Metrics and series are hardcoded. |
| Users/roles/settings/integrations | MOCKED | `backend/internal/repository/memory.go:38-177`, `backend/internal/api/handlers/admin_handler.go:14-230`, `backend/internal/api/handlers/settings_handler.go:12-212` | CRUD mutates process-local seeded maps; integration/webhook tests return hardcoded success. |
| Notifications/uploads/WebSocket | MOCKED | `backend/internal/api/handlers/notification_handler.go:14-123`, `backend/internal/api/handlers/websocket_handler.go:9-26` | Notifications are memory records; upload stores metadata but not bytes; WebSocket writes one synthetic event then closes. |
| Frontend enterprise screens | MOCKED | `frontend/src/App.jsx:30-58`, `frontend/src/constants/mockData.js:3-243` | Navigation is broad, but dashboard/workflow/execution/analytics/user/settings surfaces mostly import static mock data. Auth and chat are the main live API integrations. |

## 5. API surface

`Yes*` means the route is under JWT middleware, but the default config enables a fixed development token and also accepts tokens in the query string (`backend/internal/config/config.go:82-85`, `backend/internal/api/middlewares/auth.go:13-24`). No route applies permission middleware (`backend/internal/api/routes/routes.go:27-153`). Status here describes the handler, not production readiness.

### Go/Fiber inbound API

| Method | Path | Handler evidence | Status | Auth |
|---|---|---|---|---|
| GET | `/healthz` | `backend/internal/api/routes/routes.go:11`; `backend/internal/api/handlers/handler.go:46-52` | IMPLEMENTED | No |
| GET | `/ws/*` | `backend/internal/api/routes/routes.go:12`; `backend/internal/api/handlers/websocket_handler.go:9-26` | MOCKED | No |
| GET | `/api/health` | `backend/internal/api/routes/routes.go:14-15`; `backend/internal/api/handlers/handler.go:46-52` | IMPLEMENTED | No |
| POST | `/api/auth/login` | `backend/internal/api/routes/routes.go:17-18`; `backend/internal/api/handlers/auth_handler.go:11-53` | MOCKED | No |
| POST | `/api/auth/register` | `backend/internal/api/routes/routes.go:19`; `backend/internal/api/handlers/auth_handler.go:56-79` | MOCKED | No |
| POST | `/api/auth/refresh` | `backend/internal/api/routes/routes.go:20`; `backend/internal/api/handlers/auth_handler.go:85-91` | MOCKED | No |
| POST | `/api/auth/forgot-password` | `backend/internal/api/routes/routes.go:21`; `backend/internal/api/handlers/auth_handler.go:97-99` | MOCKED | No |
| POST | `/api/auth/reset-password` | `backend/internal/api/routes/routes.go:22`; `backend/internal/api/handlers/auth_handler.go:101-103` | MOCKED | No |
| POST | `/api/auth/verify-email` | `backend/internal/api/routes/routes.go:23`; `backend/internal/api/handlers/auth_handler.go:105-107` | MOCKED | No |
| GET | `/api/auth/oauth/:provider/authorize` | `backend/internal/api/routes/routes.go:24`; `backend/internal/api/handlers/auth_handler.go:129-132` | MOCKED | No |
| GET | `/api/auth/oauth/:provider/callback` | `backend/internal/api/routes/routes.go:25`; `backend/internal/api/handlers/auth_handler.go:134-140` | MOCKED | No |
| POST | `/api/auth/logout` | `backend/internal/api/routes/routes.go:29`; `backend/internal/api/handlers/auth_handler.go:81-83` | MOCKED | Yes* |
| GET | `/api/auth/me` | `backend/internal/api/routes/routes.go:30`; `backend/internal/api/handlers/auth_handler.go:93-95` | IMPLEMENTED | Yes* |
| POST | `/api/auth/2fa/verify` | `backend/internal/api/routes/routes.go:31`; `backend/internal/api/handlers/auth_handler.go:109-111` | MOCKED | Yes* |
| POST | `/api/auth/2fa/enable` | `backend/internal/api/routes/routes.go:32`; `backend/internal/api/handlers/auth_handler.go:113-119` | MOCKED | Yes* |
| POST | `/api/auth/2fa/disable` | `backend/internal/api/routes/routes.go:33`; `backend/internal/api/handlers/auth_handler.go:121-127` | MOCKED | Yes* |
| GET | `/api/dashboard/summary` | `backend/internal/api/routes/routes.go:35`; `backend/internal/api/handlers/dashboard_handler.go:11-20` | MOCKED | Yes* |
| GET | `/api/dashboard/activity` | `backend/internal/api/routes/routes.go:36`; `backend/internal/api/handlers/dashboard_handler.go:22-30` | MOCKED | Yes* |
| GET | `/api/dashboard/health` | `backend/internal/api/routes/routes.go:37`; `backend/internal/api/handlers/dashboard_handler.go:32-43` | MOCKED | Yes* |
| GET | `/api/dashboard/recent-workflows` | `backend/internal/api/routes/routes.go:38`; `backend/internal/api/handlers/dashboard_handler.go:45-54` | IMPLEMENTED | Yes* |
| GET | `/api/workflows/templates` | `backend/internal/api/routes/routes.go:40`; `backend/internal/api/handlers/workflow_handler.go:267-271` | IMPLEMENTED | Yes* |
| POST | `/api/workflows/templates` | `backend/internal/api/routes/routes.go:41`; `backend/internal/api/handlers/workflow_handler.go:274-284` | IMPLEMENTED | Yes* |
| POST | `/api/workflows/templates/:id/use` | `backend/internal/api/routes/routes.go:42`; `backend/internal/api/handlers/workflow_handler.go:287-312` | IMPLEMENTED | Yes* |
| GET | `/api/workflows` | `backend/internal/api/routes/routes.go:43`; `backend/internal/api/handlers/workflow_handler.go:13-24` | IMPLEMENTED | Yes* |
| POST | `/api/workflows` | `backend/internal/api/routes/routes.go:44`; `backend/internal/api/handlers/workflow_handler.go:26-63` | IMPLEMENTED | Yes* |
| GET | `/api/workflows/:id` | `backend/internal/api/routes/routes.go:45`; `backend/internal/api/handlers/workflow_handler.go:65-71` | IMPLEMENTED | Yes* |
| PATCH | `/api/workflows/:id` | `backend/internal/api/routes/routes.go:46`; `backend/internal/api/handlers/workflow_handler.go:73-105` | IMPLEMENTED | Yes* |
| DELETE | `/api/workflows/:id` | `backend/internal/api/routes/routes.go:47`; `backend/internal/api/handlers/workflow_handler.go:107-115` | IMPLEMENTED | Yes* |
| POST | `/api/workflows/:id/duplicate` | `backend/internal/api/routes/routes.go:48`; `backend/internal/api/handlers/workflow_handler.go:117-139` | IMPLEMENTED | Yes* |
| POST | `/api/workflows/:id/publish` | `backend/internal/api/routes/routes.go:49`; `backend/internal/api/handlers/workflow_handler.go:141-157` | IMPLEMENTED | Yes* |
| POST | `/api/workflows/:id/archive` | `backend/internal/api/routes/routes.go:50`; `backend/internal/api/handlers/workflow_handler.go:159-169` | IMPLEMENTED | Yes* |
| POST | `/api/workflows/:id/validate` | `backend/internal/api/routes/routes.go:51`; `backend/internal/api/handlers/workflow_handler.go:171-183` | IMPLEMENTED (weak gate only) | Yes* |
| POST | `/api/workflows/:id/run` | `backend/internal/api/routes/routes.go:52`; `backend/internal/api/handlers/execute_handler.go:10-99` | IMPLEMENTED | Yes* |
| GET | `/api/workflows/:id/yaml` | `backend/internal/api/routes/routes.go:53`; `backend/internal/api/handlers/workflow_handler.go:185-191` | IMPLEMENTED | Yes* |
| PUT | `/api/workflows/:id/yaml` | `backend/internal/api/routes/routes.go:54`; `backend/internal/api/handlers/workflow_handler.go:193-215` | IMPLEMENTED (weak gate only) | Yes* |
| GET | `/api/workflows/:id/canvas` | `backend/internal/api/routes/routes.go:55`; `backend/internal/api/handlers/workflow_handler.go:217-223` | IMPLEMENTED | Yes* |
| PUT | `/api/workflows/:id/canvas` | `backend/internal/api/routes/routes.go:56`; `backend/internal/api/handlers/workflow_handler.go:225-240` | IMPLEMENTED (unvalidated graph) | Yes* |
| GET | `/api/workflows/:id/versions` | `backend/internal/api/routes/routes.go:57`; `backend/internal/api/handlers/workflow_handler.go:242-247` | IMPLEMENTED | Yes* |
| POST | `/api/workflows/:id/restore/:versionId` | `backend/internal/api/routes/routes.go:58`; `backend/internal/api/handlers/workflow_handler.go:249-265` | IMPLEMENTED (no revalidation) | Yes* |
| GET | `/api/workflows/:id/executions` | `backend/internal/api/routes/routes.go:59`; `backend/internal/api/handlers/execute_handler.go:178-190` | IMPLEMENTED | Yes* |
| POST | `/api/synthesis` | `backend/internal/api/routes/routes.go:61`; `backend/internal/api/handlers/chat_handler.go:12-42` | MOCKED on provider failure | Yes* |
| POST | `/api/synthesis/validate` | `backend/internal/api/routes/routes.go:62`; `backend/internal/api/handlers/chat_handler.go:44-49` | IMPLEMENTED (weak gate) | Yes* |
| POST | `/api/synthesis/preview-flow` | `backend/internal/api/routes/routes.go:63`; `backend/internal/api/handlers/chat_handler.go:51-59` | IMPLEMENTED | Yes* |
| POST | `/api/synthesis/explain` | `backend/internal/api/routes/routes.go:64`; `backend/internal/api/handlers/chat_handler.go:61-73` | MOCKED explanation | Yes* |
| GET | `/api/tools/catalog` | `backend/internal/api/routes/routes.go:65`; `backend/internal/api/handlers/catalog_handler.go:11-47` | IMPLEMENTED | Yes* |
| GET | `/api/rules/catalog` | `backend/internal/api/routes/routes.go:66`; `backend/internal/api/handlers/catalog_handler.go:49-85` | IMPLEMENTED | Yes* |
| POST | `/api/semantic-search` | `backend/internal/api/routes/routes.go:67`; `backend/internal/api/handlers/catalog_handler.go:87-110` | IMPLEMENTED | Yes* |
| POST | `/api/canvas/validate-workflow` | `backend/internal/api/routes/routes.go:68`; `backend/internal/api/handlers/catalog_handler.go:112-141` | IMPLEMENTED for YAML; node conversion MISSING | Yes* |
| GET | `/api/chat/sessions` | `backend/internal/api/routes/routes.go:70`; `backend/internal/api/handlers/chat_handler.go:75-85` | IMPLEMENTED | Yes* |
| POST | `/api/chat/sessions` | `backend/internal/api/routes/routes.go:71`; `backend/internal/api/handlers/chat_handler.go:87-99` | IMPLEMENTED | Yes* |
| GET | `/api/chat/sessions/:id` | `backend/internal/api/routes/routes.go:72`; `backend/internal/api/handlers/chat_handler.go:101-109` | IMPLEMENTED | Yes* |
| PATCH | `/api/chat/sessions/:id` | `backend/internal/api/routes/routes.go:73`; `backend/internal/api/handlers/chat_handler.go:111-124` | IMPLEMENTED | Yes* |
| DELETE | `/api/chat/sessions/:id` | `backend/internal/api/routes/routes.go:74`; `backend/internal/api/handlers/chat_handler.go:126-131` | IMPLEMENTED | Yes* |
| POST | `/api/chat/sessions/:id/messages` | `backend/internal/api/routes/routes.go:75`; `backend/internal/api/handlers/chat_handler.go:133-248` | IMPLEMENTED | Yes* |
| GET | `/api/executions` | `backend/internal/api/routes/routes.go:77`; `backend/internal/api/handlers/execute_handler.go:101-117` | IMPLEMENTED | Yes* |
| GET | `/api/executions/:id` | `backend/internal/api/routes/routes.go:78`; `backend/internal/api/handlers/execute_handler.go:119-127` | IMPLEMENTED | Yes* |
| GET | `/api/executions/:id/logs` | `backend/internal/api/routes/routes.go:79`; `backend/internal/api/handlers/execute_handler.go:129-134` | IMPLEMENTED | Yes* |
| GET | `/api/executions/:id/timeline` | `backend/internal/api/routes/routes.go:80`; `backend/internal/api/handlers/execute_handler.go:136-141` | IMPLEMENTED | Yes* |
| GET | `/api/executions/:id/healing-report` | `backend/internal/api/routes/routes.go:81`; `backend/internal/api/handlers/execute_handler.go:143-151` | IMPLEMENTED | Yes* |
| POST | `/api/executions/:id/cancel` | `backend/internal/api/routes/routes.go:82`; `backend/internal/api/handlers/execute_handler.go:153-164` | IMPLEMENTED (state only) | Yes* |
| POST | `/api/executions/:id/retry` | `backend/internal/api/routes/routes.go:83`; `backend/internal/api/handlers/execute_handler.go:166-176` | IMPLEMENTED | Yes* |
| GET | `/api/analytics/summary` | `backend/internal/api/routes/routes.go:85`; `backend/internal/api/handlers/analytics_handler.go:10-20` | MOCKED | Yes* |
| GET | `/api/analytics/performance` | `backend/internal/api/routes/routes.go:86`; `backend/internal/api/handlers/analytics_handler.go:22-26` | MOCKED | Yes* |
| GET | `/api/analytics/usage` | `backend/internal/api/routes/routes.go:87`; `backend/internal/api/handlers/analytics_handler.go:28-34` | MOCKED | Yes* |
| GET | `/api/analytics/self-healing` | `backend/internal/api/routes/routes.go:88`; `backend/internal/api/handlers/analytics_handler.go:36-41` | MOCKED | Yes* |
| GET | `/api/analytics/latency` | `backend/internal/api/routes/routes.go:89`; `backend/internal/api/handlers/analytics_handler.go:43-50` | MOCKED | Yes* |
| GET | `/api/analytics/f1-score` | `backend/internal/api/routes/routes.go:90`; `backend/internal/api/handlers/analytics_handler.go:52-54` | MOCKED | Yes* |
| GET | `/api/analytics/activity-heatmap` | `backend/internal/api/routes/routes.go:91`; `backend/internal/api/handlers/analytics_handler.go:56-64` | MOCKED | Yes* |
| GET | `/api/analytics/cost-trends` | `backend/internal/api/routes/routes.go:92`; `backend/internal/api/handlers/analytics_handler.go:66-70` | MOCKED | Yes* |
| GET | `/api/users` | `backend/internal/api/routes/routes.go:94`; `backend/internal/api/handlers/admin_handler.go:14-35` | IMPLEMENTED | Yes* |
| POST | `/api/users` | `backend/internal/api/routes/routes.go:95`; `backend/internal/api/handlers/admin_handler.go:37-56` | IMPLEMENTED | Yes* |
| POST | `/api/users/invite` | `backend/internal/api/routes/routes.go:96`; `backend/internal/api/handlers/admin_handler.go:99-103` | MOCKED | Yes* |
| GET | `/api/users/:id` | `backend/internal/api/routes/routes.go:97`; `backend/internal/api/handlers/admin_handler.go:58-66` | IMPLEMENTED | Yes* |
| PATCH | `/api/users/:id` | `backend/internal/api/routes/routes.go:98`; `backend/internal/api/handlers/admin_handler.go:68-90` | IMPLEMENTED | Yes* |
| DELETE | `/api/users/:id` | `backend/internal/api/routes/routes.go:99`; `backend/internal/api/handlers/admin_handler.go:92-97` | IMPLEMENTED | Yes* |
| POST | `/api/users/:id/activate` | `backend/internal/api/routes/routes.go:100`; `backend/internal/api/handlers/admin_handler.go:105-121` | IMPLEMENTED | Yes* |
| POST | `/api/users/:id/suspend` | `backend/internal/api/routes/routes.go:101`; `backend/internal/api/handlers/admin_handler.go:109-121` | IMPLEMENTED | Yes* |
| GET | `/api/roles` | `backend/internal/api/routes/routes.go:102`; `backend/internal/api/handlers/admin_handler.go:124-129` | IMPLEMENTED | Yes* |
| POST | `/api/roles` | `backend/internal/api/routes/routes.go:103`; `backend/internal/api/handlers/admin_handler.go:131-138` | IMPLEMENTED | Yes* |
| GET | `/api/roles/:id` | `backend/internal/api/routes/routes.go:104`; `backend/internal/api/handlers/admin_handler.go:140-148` | IMPLEMENTED | Yes* |
| PATCH | `/api/roles/:id` | `backend/internal/api/routes/routes.go:105`; `backend/internal/api/handlers/admin_handler.go:150-165` | IMPLEMENTED | Yes* |
| DELETE | `/api/roles/:id` | `backend/internal/api/routes/routes.go:106`; `backend/internal/api/handlers/admin_handler.go:167-172` | IMPLEMENTED | Yes* |
| GET | `/api/permissions` | `backend/internal/api/routes/routes.go:107`; `backend/internal/api/handlers/admin_handler.go:174-179` | IMPLEMENTED | Yes* |
| GET | `/api/permissions/matrix` | `backend/internal/api/routes/routes.go:108`; `backend/internal/api/handlers/admin_handler.go:181-195` | IMPLEMENTED | Yes* |
| GET | `/api/audit/export` | `backend/internal/api/routes/routes.go:109`; `backend/internal/api/handlers/admin_handler.go:216-230` | IMPLEMENTED | Yes* |
| GET | `/api/audit` | `backend/internal/api/routes/routes.go:110`; `backend/internal/api/handlers/admin_handler.go:197-204` | IMPLEMENTED | Yes* |
| GET | `/api/audit/:id` | `backend/internal/api/routes/routes.go:111`; `backend/internal/api/handlers/admin_handler.go:206-214` | IMPLEMENTED | Yes* |
| GET | `/api/profile` | `backend/internal/api/routes/routes.go:113`; `backend/internal/api/handlers/profile_handler.go:12-16` | IMPLEMENTED | Yes* |
| PATCH | `/api/profile` | `backend/internal/api/routes/routes.go:114`; `backend/internal/api/handlers/profile_handler.go:18-28` | IMPLEMENTED | Yes* |
| PATCH | `/api/profile/security` | `backend/internal/api/routes/routes.go:115`; `backend/internal/api/handlers/profile_handler.go:30-38` | MOCKED/PARTIAL | Yes* |
| GET | `/api/profile/notifications` | `backend/internal/api/routes/routes.go:116`; `backend/internal/api/handlers/profile_handler.go:40-42` | MOCKED | Yes* |
| PATCH | `/api/profile/notifications` | `backend/internal/api/routes/routes.go:117`; `backend/internal/api/handlers/profile_handler.go:44-47` | MOCKED | Yes* |
| GET | `/api/profile/api-keys` | `backend/internal/api/routes/routes.go:118`; `backend/internal/api/handlers/profile_handler.go:49-54` | IMPLEMENTED | Yes* |
| POST | `/api/profile/api-keys` | `backend/internal/api/routes/routes.go:119`; `backend/internal/api/handlers/profile_handler.go:56-64` | IMPLEMENTED (not enforced for auth) | Yes* |
| DELETE | `/api/profile/api-keys/:id` | `backend/internal/api/routes/routes.go:120`; `backend/internal/api/handlers/profile_handler.go:66-71` | IMPLEMENTED | Yes* |
| GET | `/api/settings` | `backend/internal/api/routes/routes.go:122`; `backend/internal/api/handlers/settings_handler.go:12-17` | IMPLEMENTED | Yes* |
| PATCH | `/api/settings` | `backend/internal/api/routes/routes.go:123`; `backend/internal/api/handlers/settings_handler.go:19-33` | IMPLEMENTED | Yes* |
| GET | `/api/settings/general` | `backend/internal/api/routes/routes.go:124`; `backend/internal/api/handlers/settings_handler.go:35-40` | IMPLEMENTED | Yes* |
| PATCH | `/api/settings/general` | `backend/internal/api/routes/routes.go:125`; `backend/internal/api/handlers/settings_handler.go:42-49` | IMPLEMENTED | Yes* |
| GET | `/api/settings/llm` | `backend/internal/api/routes/routes.go:126`; `backend/internal/api/handlers/settings_handler.go:51-56` | IMPLEMENTED (not wired to runtime) | Yes* |
| PATCH | `/api/settings/llm` | `backend/internal/api/routes/routes.go:127`; `backend/internal/api/handlers/settings_handler.go:58-65` | IMPLEMENTED (not wired to runtime) | Yes* |
| GET | `/api/settings/rbac` | `backend/internal/api/routes/routes.go:128`; `backend/internal/api/handlers/settings_handler.go:67-72` | IMPLEMENTED (not enforced) | Yes* |
| PATCH | `/api/settings/rbac` | `backend/internal/api/routes/routes.go:129`; `backend/internal/api/handlers/settings_handler.go:74-81` | IMPLEMENTED (not enforced) | Yes* |
| GET | `/api/settings/webhooks` | `backend/internal/api/routes/routes.go:130`; `backend/internal/api/handlers/settings_handler.go:83-88` | IMPLEMENTED | Yes* |
| POST | `/api/settings/webhooks` | `backend/internal/api/routes/routes.go:131`; `backend/internal/api/handlers/settings_handler.go:90-97` | IMPLEMENTED | Yes* |
| PATCH | `/api/settings/webhooks/:id` | `backend/internal/api/routes/routes.go:132`; `backend/internal/api/handlers/settings_handler.go:99-120` | IMPLEMENTED | Yes* |
| DELETE | `/api/settings/webhooks/:id` | `backend/internal/api/routes/routes.go:133`; `backend/internal/api/handlers/settings_handler.go:122-127` | IMPLEMENTED | Yes* |
| POST | `/api/settings/webhooks/:id/test` | `backend/internal/api/routes/routes.go:134`; `backend/internal/api/handlers/settings_handler.go:129-131` | MOCKED | Yes* |
| GET | `/api/integrations` | `backend/internal/api/routes/routes.go:136`; `backend/internal/api/handlers/settings_handler.go:133-138` | IMPLEMENTED | Yes* |
| POST | `/api/integrations` | `backend/internal/api/routes/routes.go:137`; `backend/internal/api/handlers/settings_handler.go:140-150` | IMPLEMENTED | Yes* |
| GET | `/api/integrations/:id` | `backend/internal/api/routes/routes.go:138`; `backend/internal/api/handlers/settings_handler.go:152-160` | IMPLEMENTED | Yes* |
| PATCH | `/api/integrations/:id` | `backend/internal/api/routes/routes.go:139`; `backend/internal/api/handlers/settings_handler.go:162-177` | IMPLEMENTED | Yes* |
| DELETE | `/api/integrations/:id` | `backend/internal/api/routes/routes.go:140`; `backend/internal/api/handlers/settings_handler.go:179-184` | IMPLEMENTED | Yes* |
| POST | `/api/integrations/:id/test` | `backend/internal/api/routes/routes.go:141`; `backend/internal/api/handlers/settings_handler.go:186-194` | MOCKED | Yes* |
| POST | `/api/integrations/:id/connect` | `backend/internal/api/routes/routes.go:142`; `backend/internal/api/handlers/settings_handler.go:196-212` | MOCKED state change | Yes* |
| POST | `/api/integrations/:id/disconnect` | `backend/internal/api/routes/routes.go:143`; `backend/internal/api/handlers/settings_handler.go:200-212` | MOCKED state change | Yes* |
| GET | `/api/notifications` | `backend/internal/api/routes/routes.go:145`; `backend/internal/api/handlers/notification_handler.go:14-29` | IMPLEMENTED | Yes* |
| PATCH | `/api/notifications/read-all` | `backend/internal/api/routes/routes.go:146`; `backend/internal/api/handlers/notification_handler.go:42-49` | IMPLEMENTED | Yes* |
| PATCH | `/api/notifications/:id/read` | `backend/internal/api/routes/routes.go:147`; `backend/internal/api/handlers/notification_handler.go:31-40` | IMPLEMENTED | Yes* |
| DELETE | `/api/notifications/:id` | `backend/internal/api/routes/routes.go:148`; `backend/internal/api/handlers/notification_handler.go:51-56` | IMPLEMENTED | Yes* |
| POST | `/api/upload` | `backend/internal/api/routes/routes.go:149`; `backend/internal/api/handlers/notification_handler.go:58-68` | MOCKED (metadata only) | Yes* |
| GET | `/api/upload/:id` | `backend/internal/api/routes/routes.go:150`; `backend/internal/api/handlers/notification_handler.go:70-78` | MOCKED (metadata only) | Yes* |
| DELETE | `/api/upload/:id` | `backend/internal/api/routes/routes.go:151`; `backend/internal/api/handlers/notification_handler.go:80-85` | MOCKED (metadata only) | Yes* |
| POST | `/api/upload/workflow-import` | `backend/internal/api/routes/routes.go:152`; `backend/internal/api/handlers/notification_handler.go:87-111` | IMPLEMENTED | Yes* |

There is no route for the advertised upload download URL `/api/upload/:id/download`; the URL is generated at `backend/internal/api/handlers/notification_handler.go:113-123` but no matching route exists in `backend/internal/api/routes/routes.go:10-153`.

### Python semantic-search API

| Method | Path | Handler | Status | Auth |
|---|---|---|---|---|
| GET | `/health` | `backend/semantic_search_service/app.py:174-191` | IMPLEMENTED | No |
| GET | `/index/status` | `backend/semantic_search_service/app.py:194-211` | IMPLEMENTED | No |
| POST | `/index/rebuild` | `backend/semantic_search_service/app.py:214-220` | IMPLEMENTED, expensive state mutation | No |
| POST | `/search` | `backend/semantic_search_service/app.py:223-255` | IMPLEMENTED | No |

### Outbound/external contracts

| Direction | Method/path | Evidence | Status/auth |
|---|---|---|---|
| Go -> semantic service | `POST ${SEMANTIC_SEARCH_URL}` with query, role, four Top-K fields | `backend/internal/core/semanticsearch/service.go:126-158` | IMPLEMENTED; no service auth |
| Go -> Gemini | `POST /v1beta/models/:model:generateContent?key=[REDACTED]` | `backend/internal/core/synthesizer/gemini_client.go:42-68` | IMPLEMENTED; API key in query string |
| Go -> MCP middleware | `POST ${MCP_BASE_URL}/tools/execute` with `{action,parameters}` | `backend/internal/tools/mcp_client.go:35-63` | PARTIAL/custom bridge; no auth header |
| Python -> Ollama | `POST /api/embed`, fallback `/api/embeddings` | `backend/semantic_search_service/app.py:299-338` | IMPLEMENTED; no auth |

No gRPC services and no inbound MCP server endpoints were found: **NOT FOUND** in `backend/`.

## 6. Data layer

### Actual storage

No migration files, SQL queries, ORM, or concrete database tables were found: **NOT FOUND**. `DATABASE_URL` and `REDIS_URL` are configuration-only; both adapters explicitly select memory mode (`backend/internal/config/db.go:11-19`, `backend/internal/config/redis.go:11-19`). `backend/internal/repository/workflow_repo.go` and `backend/internal/repository/audit_repo.go` are comments marking future persistence boundaries (`backend/internal/repository/workflow_repo.go:1-4`, `backend/internal/repository/audit_repo.go:1-4`).

All application data is stored in one mutex-protected `Store` and is lost on process restart (`backend/internal/repository/memory.go:13-38`).

| In-memory collection/schema | Fields | Main readers/writers |
|---|---|---|
| `Users` | id, name, email, role, permissions, status, initials, lastLoginAt, createdAt, 2FA, emailVerified (`backend/internal/models/user.go:10-22`) | Auth/admin/profile handlers (`backend/internal/api/handlers/auth_handler.go:11-79`, `backend/internal/api/handlers/admin_handler.go:14-121`, `backend/internal/api/handlers/profile_handler.go:12-38`). |
| `Roles`, `Permissions` | Role: id/name/description/permissions/createdAt; Permission: key/name/description/group (`backend/internal/models/user.go:24-37`) | Admin CRUD/matrix and validator role name lookup (`backend/internal/api/handlers/admin_handler.go:124-195`, `backend/internal/api/handlers/execute_handler.go:27-35`). |
| `Workflows` | id, name, description, owner, status, trigger, step count, success rate, run/version/tag/YAML/canvas/timestamps/archive fields (`backend/internal/models/workflow.go:38-56`) | Workflow handlers and execution (`backend/internal/api/handlers/workflow_handler.go:13-320`, `backend/internal/api/handlers/execute_handler.go:18-99`). |
| `Versions` | id, workflowId, version, note, YAML, createdAt/by (`backend/internal/models/workflow.go:91-99`) | Publish/list/restore (`backend/internal/api/handlers/workflow_handler.go:141-157`, `:242-265`). |
| `Templates` | id, name, description, category, tags, YAML, steps, createdAt (`backend/internal/models/workflow.go:101-110`) | Template list/create/use (`backend/internal/api/handlers/workflow_handler.go:267-312`). |
| `Executions` | id, workflowId/name, status, started/completed/duration, token counters, cost, startedBy (`backend/internal/models/state.go:12-23`) | Run/list/get/cancel/retry (`backend/internal/api/handlers/execute_handler.go:45-98`, `:101-176`). Token/cost fields are hardcoded at run creation (`backend/internal/api/handlers/execute_handler.go:45-50`). |
| `ExecutionLogs` | id, executionId, timestamp, level, nodeId, message, metadata (`backend/internal/models/state.go:25-33`) | Runner produces; execution endpoints read (`backend/internal/core/runner/executor.go:70-86`, `backend/internal/api/handlers/execute_handler.go:129-134`). |
| `Timelines` | id, nodeId, label, status, start/end/duration (`backend/internal/models/state.go:35-43`) | Runner produces; timeline endpoint reads (`backend/internal/core/runner/executor.go:45-86`, `backend/internal/api/handlers/execute_handler.go:136-141`). |
| `Healing` | executionId, workflowId, status, summary, free-form events/metrics (`backend/internal/models/state.go:45-52`) | Failure handler writes; report endpoint reads (`backend/internal/api/handlers/execute_handler.go:61-87`, `:143-151`). |
| `Chats` | session id/title/timestamps/count plus messages id/role/text/artifacts/time (`backend/internal/models/settings.go:32-50`) | Chat CRUD and orchestration response persistence (`backend/internal/api/handlers/chat_handler.go:75-248`). No user/tenant owner field exists. |
| `Settings` | three untyped maps: General, LLM, RBAC (`backend/internal/models/settings.go:5-9`) | Settings endpoints mutate maps (`backend/internal/api/handlers/settings_handler.go:12-81`); runtime config does not read them. |
| `Integrations` | id/name/type/status/icon/config/tested/created (`backend/internal/models/settings.go:11-20`) | Integration CRUD/test/connect (`backend/internal/api/handlers/settings_handler.go:133-212`). |
| `Webhooks` | id/name/url/events/enabled/secretPreview/createdAt (`backend/internal/models/settings.go:22-30`) | Webhook CRUD/test (`backend/internal/api/handlers/settings_handler.go:83-131`); no event dispatcher reads them. |
| `AuditLogs` | id, actor, action, resource, IP, user-agent, before/after, createdAt (`backend/internal/models/user.go:39-49`) | Store audit helper and audit list/export (`backend/internal/repository/memory.go:213-218`, `backend/internal/api/handlers/admin_handler.go:197-230`). |
| `Notifications` | id/message/tone/type/read/resource/createdAt (`backend/internal/models/user.go:79-87`) | Notification handlers (`backend/internal/api/handlers/notification_handler.go:14-56`). |
| `APIKeys` | id/name/key/maskedKey/scopes/createdAt/expiresAt (`backend/internal/models/user.go:69-77`) | Profile endpoints create/list/delete (`backend/internal/api/handlers/profile_handler.go:49-71`); auth middleware never consumes them. |
| `Uploads` | id/name/MIME/size/URL/checksum/createdAt (`backend/internal/models/api.go:114-122`) | Upload endpoints store only `FileHeader` metadata (`backend/internal/api/handlers/notification_handler.go:58-68`, `:113-123`). |

The tool/rule/template/example registries are file-backed JSON read at startup, deduplicated, sorted, and versioned by SHA-256 (`backend/internal/core/registry/loader.go:24-72`, `:120-234`, `:277-288`). They are not mutable through the API.

## 7. LLM integration audit

### Call sites

| Call path | Provider/model | Prompt/context | Output handling | Limits/retry/cache/token estimate |
|---|---|---|---|---|
| Direct synthesis: `/api/synthesis` and nil-orchestrator fallback | Gemini, configured model default `gemini-1.5-flash` (`backend/internal/config/config.go:103-106`) | Generic system instructions, fixed 9-action catalog, YAML schema, governance bullets, mode, entire caller-supplied context formatted with `%+v`, and user prompt (`backend/internal/core/synthesizer/prompt_gen.go:28-63`). No repository files are read by this call. | Removes a markdown fence, then the endpoint runs the weak schema/semantic validator (`backend/internal/core/synthesizer/gemini_client.go:97-119`, `backend/internal/api/handlers/chat_handler.go:22-38`). Provider errors are silently replaced with deterministic YAML and returned as success (`backend/internal/core/synthesizer/ollama_client.go:56-75`). | 60 s HTTP timeout, temperature 0.1, top-p 0.8, max output 8,192 (`backend/internal/core/synthesizer/gemini_client.go:21-30`, `:51-55`). No retry/cache. Reported 1,210 input/830 output tokens are fixed constants, not measurements (`backend/internal/core/synthesizer/ollama_client.go:64-74`). |
| Chat candidate generation | Gemini, configured/default model (`backend/internal/core/synthesizer/candidates.go:37-64`) | User role/request; summaries of retrieved executable, schema-missing, and future tools; relevant rule summaries; up to 5 full typed process-template records; up to 5 synthesized few-shot YAML examples (`backend/internal/core/synthesizer/candidates.go:67-193`). Secret-like `key=value` prompt fragments are redacted (`backend/internal/core/synthesizer/candidates.go:632-635`). It sends selected records, not whole source files. | One response is parsed as JSON wrapper, candidate separators, or one YAML block (`backend/internal/core/synthesizer/candidates.go:196-260`); every candidate then passes the deterministic registry validator and selector (`backend/internal/core/orchestrator/chat_orchestrator.go:120-156`). A generation error aborts the request; the deterministic multi-candidate fallback functions are unused (`backend/internal/core/synthesizer/candidates.go:440-466`). | One LLM call for up to 5 candidates (`backend/internal/core/synthesizer/candidates.go:37-54`), 60 s/8,192 output tokens through Gemini. No retry, cache, actual usage, or input-token bound. Prompt size is indirectly limited by Top-K 10/15/5/5 and candidate max 5 (`backend/internal/core/orchestrator/chat_orchestrator.go:31-45`). Token estimate: **NOT DETERMINABLE**. |
| Execution self-healing | Same direct synthesis service; normally Gemini | The repair request embeds the workflow name, **entire failing YAML**, and execution error, then the generic prompt builder wraps that repair text again (`backend/internal/core/healing/error_loop.go:20-38`, `backend/internal/core/synthesizer/ollama_client.go:56-58`). | `Synthesize` may silently return deterministic fallback YAML; repaired YAML is registry-validated and saved only if it passes (`backend/internal/api/handlers/execute_handler.go:61-86`). It is not automatically rerun. | `MaxAttempts=1` but no loop; 60 s Gemini timeout and 8,192 output cap; no token/time budget, retry/backoff, or cache (`backend/internal/core/healing/error_loop.go:11-23`, `backend/internal/core/synthesizer/gemini_client.go:21-30`, `:51-55`). Token estimate: **NOT DETERMINABLE**. |

### Provider conclusions

- Gemini is the only enabled workflow-generation provider. `Service.generate` rejects non-Gemini providers even though an Ollama client implementation exists (`backend/internal/core/synthesizer/ollama_client.go:78-87`, `:89-134`).
- The Gemini key is placed in the request query string, which can leak through proxies/logs; the value is **[REDACTED]** (`backend/internal/core/synthesizer/gemini_client.go:61-68`).
- Gemini output is not constrained with a provider-side response schema/JSON schema and has no safety-setting configuration, retry, backoff, or candidate-level second attempt (`backend/internal/core/synthesizer/gemini_client.go:42-56`, `:68-104`).
- The 5,000-case test named Gemini generation uses a sequenced mock, not Gemini (`backend/tests/unit/semantic_and_generation_accuracy_test.go:113-150`). The only live Gemini test is opt-in and was skipped (`backend/tests/unit/semantic_and_generation_accuracy_test.go:178-191`).
- LLM response caching is **NO / NOT FOUND**. Semantic **embedding** caching is separate and writes FAISS, document, vector, and metadata files keyed by a dataset/config fingerprint (`backend/semantic_search_service/app.py:540-631`).
- Conversation context is **NOT IMPLEMENTED**: chat generation sends the current message and retrieved context but not previous messages (`backend/internal/api/handlers/chat_handler.go:191-205`, `backend/internal/core/orchestrator/chat_orchestrator.go:102-115`).

## 8. Deterministic validation gate deep dive

### What is actually enforced

There are two different validators, and treating them as one would overstate the safety boundary.

1. The lightweight `Validator` parses YAML, validates the Go struct, and applies a short semantic check (`backend/internal/core/validator/schema_check.go:19-56`). Its semantic rules reject action names containing `sql`, `database`, or `drop`; restrict a small hardcoded set of write actions by role; and warn when retry count is absent (`backend/internal/core/validator/semantic_gate.go:16-70`). An empty permission list is treated as permission to run (`backend/internal/core/validator/semantic_gate.go:56-60`). It does not prove that a tool exists, validate a tool's declared parameter schema, or evaluate the policy registry.
2. `RegistryValidator` parses and schema-checks YAML; requires a description; resolves each action against the tool registry; checks tool status, required parameters, role permission, and recursively scans sensitive keys (`backend/internal/core/validator/registry_validator.go:47-149`, `:349-391`). It then evaluates applicable registry rules and passes only when all result groups pass (`backend/internal/core/validator/registry_validator.go:151-310`).

| Check type | Status | Exact behavior and limitations |
|---|---|---|
| YAML/blueprint shape | **Implemented** | YAML unmarshal plus struct validation in both validators (`backend/internal/core/validator/schema_check.go:19-56`, `backend/internal/core/validator/registry_validator.go:47-83`). Unknown YAML fields are not rejected because strict decoding is not used. |
| Tool existence/status | **Implemented** in registry gate | Looks up every step action and rejects unknown or unavailable tools (`backend/internal/core/validator/registry_validator.go:85-109`). The lightweight validator does not. |
| Required parameter presence | **Implemented** in registry gate | Checks registry-declared required keys (`backend/internal/core/validator/registry_validator.go:110-125`). Type, enum, format, and additional-property constraints are **NOT FOUND**. |
| Role/RBAC | **Partial** | Registry validation compares the current role to tool permissions and supports an admin override (`backend/internal/core/validator/registry_validator.go:126-135`, `:378-391`). Runtime routes have authentication but no route-level RBAC middleware (`backend/internal/api/routes/routes.go:27-153`, `backend/internal/api/middlewares/rbac.go:8-16`). |
| Sensitive parameter scan | **Implemented, heuristic** | Recursively rejects keys matching a fixed sensitive-key set (`backend/internal/core/validator/registry_validator.go:136-149`, `:349-375`). It cannot detect secrets placed under innocuous key names or embedded in free text. |
| Parameter rules | **Implemented** | Evaluates required/forbidden parameter conditions (`backend/internal/core/validator/registry_validator.go:192-208`). |
| Threshold rules | **Partial / bypassable for dynamic values** | Numeric literals are compared to the threshold (`backend/internal/core/validator/registry_validator.go:210-231`). Strings beginning with `{{` are non-numeric and fail conversion rather than being constrained at runtime (`backend/internal/core/validator/registry_validator.go:526-548`); no post-resolution validation is performed by the runner. |
| Process ordering | **Implemented, static** | Compares action positions in the submitted step list (`backend/internal/core/validator/registry_validator.go:233-249`). The runner itself ignores conditions and branches, so the static order is also the execution order. |
| Separation of duties | **Partial** | Compares requester and approver values within the same step (`backend/internal/core/validator/registry_validator.go:251-260`). It does not bind either identity to authenticated principals or persist an approval decision. |
| Risk/approval | **Partial** | Risk rules inspect declared values and approval is inferred through substring matching (`backend/internal/core/validator/registry_validator.go:262-274`, `:574-581`). There is no durable approval state or resume token. |
| Audit | **Partial** | The rule confirms that an expected action exists (`backend/internal/core/validator/registry_validator.go:276-288`); it does not prove that execution emitted an immutable audit event. |
| `data_confidentiality`, `execution_safety`, `capability_gap`, `cache_safety` | **Missing as explicit evaluators** | The rule switch has dedicated evaluation only for RBAC, parameter, threshold, process order, separation of duties, risk, and audit (`backend/internal/core/validator/registry_validator.go:151-175`). Other types can influence prompt/retrieval context but are not deterministically enforced. |
| LLM participation | **None in the gate** | Registry validation is deterministic Go code. LLM generation occurs before it, and healing uses an LLM before validating the repair. |

### Gate placement and bypass search

The normal `/workflows/:id/run` path first invokes the lightweight validator and then the registry validator; with the production constructor in `main`, the full validator is non-nil (`backend/internal/api/handlers/execute_handler.go:18-43`, `backend/cmd/server/main.go:50-70`). That is the strongest path in the application.

The full gate is **not** a universal pre-persistence or pre-state-transition invariant:

- Workflow create and YAML update use only the lightweight validator (`backend/internal/api/handlers/workflow_handler.go:26-63`, `:193-215`).
- `/workflows/validate` also exposes only the lightweight result (`backend/internal/api/handlers/workflow_handler.go:171-183`).
- Template use persists even when weak validation fails, substituting an empty canvas (`backend/internal/api/handlers/workflow_handler.go:287-312`).
- Publish and version restore do not revalidate YAML (`backend/internal/api/handlers/workflow_handler.go:141-157`, `:249-265`).
- Canvas updates accept an arbitrary graph without regenerating or validating workflow YAML (`backend/internal/api/handlers/workflow_handler.go:225-240`). Canvas validation uses the full gate only when YAML is supplied; graph-to-blueprint validation is absent (`backend/internal/api/handlers/catalog_handler.go:112-141`).
- Direct synthesis and its validate/preview/explain helpers use the lightweight validator (`backend/internal/api/handlers/chat_handler.go:12-42`). Chat orchestration is stronger because it runs candidates through `RegistryValidator` (`backend/internal/core/orchestrator/chat_orchestrator.go:120-156`).
- `execute_handler` conditionally skips registry validation when `RegistryValidator == nil`; dry-run behavior is also inside that condition, so a custom/test wiring with nil can execute a request marked dry-run (`backend/internal/api/handlers/execute_handler.go:29-43`). Production `main` supplies it, but the safety property is optional rather than constructor-enforced.
- `Runner.Run` is exported and has no internal validation (`backend/internal/core/runner/executor.go:28-90`). The repository's only call is the execution handler (`backend/internal/api/handlers/execute_handler.go:56`), but future/internal callers can bypass the gate.
- Runtime template substitution happens after validation (`backend/internal/core/runner/state_manager.go:19-32`). Values such as dynamic transfer amounts are not checked again against threshold or sensitive-data rules.

**Bottom line:** a normally wired HTTP run is gated before tool execution, but invalid workflows can be stored/published/restored, and validation does not constrain resolved runtime values. The most consequential bypass is a safe-looking `{{variable}}` value that becomes policy-violating after state resolution.

## 9. Self-healing audit

### Trigger and flow

Any `Runner.Run` error causes the execution to enter `HEALING`, stores a preliminary report, and calls the healer with the entire YAML and error text (`backend/internal/api/handlers/execute_handler.go:56-73`). `ErrorLoop.Heal` only checks that `MaxAttempts` is positive; despite the name, it performs one synthesis call and has no loop, backoff, error taxonomy, or per-error repair strategy (`backend/internal/core/healing/error_loop.go:11-51`). The repaired YAML is accepted only after the registry validator passes, then it overwrites the saved workflow YAML (`backend/internal/api/handlers/execute_handler.go:74-87`). The failed execution is not automatically retried.

### Safety and integrity assessment

| Property | Status | Evidence |
|---|---|---|
| Bounded attempts | **Partial** | `MaxAttempts` is set to 1, but it is used only as an enable/disable check (`backend/internal/core/healing/error_loop.go:11-23`). |
| Repair validation | **Implemented** for normal wiring | Repair YAML passes the full registry validator before save (`backend/internal/api/handlers/execute_handler.go:74-86`). If the validator is nil, `repairValid` remains true, so the same optional-wiring bypass applies. |
| Retry of repaired execution | **Missing** | No second `Runner.Run` follows repair; the response is accepted asynchronously with HTTP 202 (`backend/internal/api/handlers/execute_handler.go:74-99`). |
| Side-effect/idempotency protection | **Missing** | The sequential runner may have successfully executed earlier tools before a later one fails (`backend/internal/core/runner/executor.go:38-69`). `IdempotencyKey` is declared but unused (`backend/internal/models/state.go:54-58`). The report's `duplicateWritesPrevented` metric is hardcoded true rather than measured (`backend/internal/api/handlers/execute_handler.go:68-73`). |
| Approval before mutation | **Missing** | A passing repair directly replaces workflow YAML without human review (`backend/internal/api/handlers/execute_handler.go:74-87`). |
| Failure reporting | **Partial** | Initial healing state is stored, but if synthesis fails the status can remain `HEALING` with no terminal event (`backend/internal/api/handlers/execute_handler.go:61-87`). |
| Secret minimization | **Missing** | Entire YAML and raw execution error are embedded in the repair prompt (`backend/internal/core/healing/error_loop.go:20-38`); only the generic prompt redaction path covers `key=value`-like fragments, not arbitrary YAML values. |
| Observability | **Partial** | A free-form healing report is queryable, but there are no attempt logs, prompt/response hashes, model usage, repair diff, or linkage to an immutable version (`backend/internal/models/state.go:45-52`). |

The failure mode is especially risky for non-transactional MCP tools: steps 1..N may already have external side effects, step N+1 fails, and the system claims duplicate prevention without any execution key, compensation action, or tool-level idempotency contract.

## 10. Integration contracts

| Boundary | Contract found | Versioning/validation | Assessment |
|---|---|---|---|
| Dataset to registry loader | JSON files for tools, rules, templates, and examples; typed Go `Tool`/`Rule` models for governance (`backend/internal/core/registry/models.go:3-61`) | Startup parsing, dedupe, sorting, and SHA-256 registry hashes (`backend/internal/core/registry/loader.go:24-72`, `:120-234`, `:277-288`) | **Implemented** for local, immutable-at-runtime registries. No migration/version field for individual records. |
| Go orchestration to semantic service | POST search request with query/kinds/top-k; response items are converted through loose `Original` maps (`backend/internal/core/semanticsearch/service.go:126-158`) | HTTP/status/JSON checks only | **Partial**. Go and Python types are maintained independently; no OpenAPI/code generation or compatibility test. |
| Python index to embedding provider | Ollama embeddings endpoint or local sentence-transformer branch (`backend/semantic_search_service/app.py:269-352`) | Provider/model fingerprint participates in cache metadata (`app.py:540-631`) | **Partial**. `sentence_transformers` is used conditionally but not pinned in `backend/semantic_search_service/requirements.txt`. |
| Runner to tool execution | The runner resolves a registered `Tool` and calls its untyped `Execute`; generic registered tools delegate to MCP (`backend/internal/core/runner/executor.go:52-69`, `backend/internal/tools/registry.go:34-45`, `backend/internal/tools/mcp_client.go:66-87`) | Tool existence checked before execution in normal run; no response schema | **Partial**. No typed per-tool input/output contract at the execution boundary. |
| MCP client to remote server | Custom POST `/tools/execute` with tool and params, or local mock when no base URL (`backend/internal/tools/mcp_client.go:24-63`) | Status-code check and untyped JSON map | **Mocked/partial**. This is not an implementation of the MCP protocol handshake, capability discovery, JSON-RPC framing, auth, or negotiated schemas. |
| Go to Gemini | REST `generateContent`, model in path, API key in query, typed request and partial response structs (`backend/internal/core/synthesizer/gemini_client.go:33-104`) | HTTP/status checks; output parsed ad hoc | **Partial**. No response schema, safety contract, retry policy, or usage extraction. |
| Frontend to backend chat | Axios service and chat hooks call the real API (`frontend/src/services/chat.service.js:1-29`, `frontend/src/hooks/useChat.js:1-79`) | Runtime property access only | **Partial**. Candidate UI expects `id/status/score`, while backend emits `candidate_id` with nested validation (`frontend/src/components/chat/ChatArtifactPanel.jsx:395-408`, `backend/internal/core/orchestrator/orchestration_models.go:23-28`). |
| Frontend workflows/execution to backend | Backend routes exist, but UI hooks/services return mock data or simulate execution (`frontend/src/hooks/useWorkflows.js:1-12`, `frontend/src/services/workflow.service.js:1-13`, `frontend/src/components/canvas/WorkflowBuilderCanvas.jsx:511-560`) | None | **Mocked** end to end. |

There is no shared schema package, generated client, OpenAPI document, event schema registry, or consumer-driven contract suite. Registry hashes provide useful dataset identity, but they are not exposed as a compatibility negotiation mechanism between services.

## 11. Configuration and environment variables

Secret values were not copied into this report. The ignored development environment file was inspected only to determine whether variables were set; values are **[REDACTED]**. Environment files are ignored except examples (`.gitignore:1-6`).

### Go backend

All variables below are read in `backend/internal/config/config.go:62-108`; parsing helpers are at `:141-174`.

| Variable | Default / behavior |
|---|---|
| `APP_ENV` | `development` |
| `APP_NAME` | `Agentic Workflow Engine` |
| `APP_HOST`, `APP_PORT` | `0.0.0.0`, `8080` |
| `API_BASE_PATH` | `/api` |
| `FRONTEND_URL` | `http://127.0.0.1:5173` |
| `JWT_SECRET` | Hardcoded development secret **[REDACTED]**; unsafe if not overridden |
| `JWT_EXPIRES_MINUTES` | `60` |
| `ALLOW_DEV_AUTH` | `true`; enables fixed development-token bypass |
| `DEV_USER_ROLE` | Empty |
| `DATABASE_URL`, `REDIS_URL` | Hardcoded local connection defaults with credentials/locations **[REDACTED]**; currently not used by real clients |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_ENABLED` | `http://localhost:11434`, `phi3:mini`, `false` |
| `MCP_BASE_URL`, `MCP_TIMEOUT_SECONDS` | Empty (therefore mock client), `15` |
| `DATASET_ROOT` | `./dataset`, resolved relative to backend |
| `TOOL_REGISTRY_PATH` | `./configs/registries/all_tools_master_registry.json` |
| `RULE_REGISTRY_PATH` | `./configs/registries/all_rules_master_registry.json` |
| `SEMANTIC_SEARCH_MODE` | `external_embedding` |
| `SEMANTIC_SEARCH_URL` | `http://localhost:8090/search` |
| `SEMANTIC_SEARCH_TOP_K_TOOLS`, `_RULES`, `_TEMPLATES`, `_EXAMPLES` | `10`, `15`, `5`, `5` |
| `SEMANTIC_SEARCH_ALLOW_LEXICAL_FALLBACK` | `false` |
| `WORKFLOW_GENERATION_PROVIDER` | `gemini`; other providers are rejected by active generation code |
| `GEMINI_API_KEY` | Empty; the inspected development file contains a set value **[REDACTED]** |
| `GEMINI_MODEL` | `gemini-1.5-flash` |
| `CANDIDATE_COUNT` | `5`, later bounded by generation code |
| `CHAT_TRACE_BOXES` | Defaults true only in development |
| `CHAT_USER_ROLE_OVERRIDE` | Falls back to `DEV_USER_ROLE` |

The example file documents the backend variables (`backend/.env.example:1-55`). Startup does not enforce production-safe values, so the development JWT/auth defaults can remain active outside development.

### Python semantic search service

Variables are read at module initialization (`backend/semantic_search_service/app.py:79-102`).

| Variable | Default / behavior |
|---|---|
| `DATASET_ROOT` | `../dataset` |
| `EMBEDDING_PROVIDER` | `ollama` |
| `EMBEDDING_MODEL` | Falls back to `OLLAMA_EMBEDDING_MODEL`, then `nomic-embed-text` |
| `OLLAMA_EMBEDDING_MODEL` | Compatibility fallback for model name |
| `OLLAMA_EMBEDDING_BASE_URL` | `http://localhost:11434` |
| `OLLAMA_EMBEDDING_TIMEOUT_SECONDS` | `60` |
| `INDEX_PROFILE` | `dev` |
| `INDEX_MAX_ITEMS_PER_FILE` | Profile-derived; development defaults to 25 |
| `INDEX_MAX_TOOLS_PER_FILE`, `INDEX_MAX_RULES_PER_FILE` | `0`, meaning full inclusion |
| `INDEX_MAX_TEMPLATES_PER_FILE`, `INDEX_MAX_EXAMPLES_PER_FILE` | Fall back to the general maximum |
| `EMBED_BATCH_SIZE` | `32` |
| `EMBEDDING_TEXT_MAX_CHARS` | `2000` |
| `REBUILD_SEMANTIC_INDEX` | `false` |
| `INDEX_INCLUDE_TOOLS`, `_RULES`, `_TEMPLATES`, `_EXAMPLES` | `true` |
| `INDEX_INCLUDE_VALIDATOR_CASES` | `false` |
| `SEMANTIC_INDEX_CACHE_DIR` | `.cache` |
| `SEMANTIC_SEARCH_LOG_LEVEL` | `INFO` |

### Frontend

| Variable | Default / behavior |
|---|---|
| `VITE_APP_NAME` | `Agentic Workflow Engine` |
| `VITE_API_BASE_URL` | `http://localhost:8080/api` |
| `VITE_WS_BASE_URL` | `ws://localhost:8080/ws`; no backend WebSocket route was found |
| `VITE_ANALYTICS_ENABLED` | Enabled only when exactly `true` |
| `VITE_SENTRY_DSN` | Empty/unset disables Sentry |

Frontend reads are at `frontend/src/config/app.js:1-7` and `frontend/src/config/sentry.js:1-7`; example values are in `frontend/.env.example:1-5`.

### Secrets and sensitive configuration locations

- `backend/.env.development` contains a JWT variable and a set Gemini key; values are **[REDACTED]** and the file is ignored.
- Backend defaults include a JWT secret, development auth token, and local database/Redis connection strings (`backend/internal/config/config.go:82-87`, `backend/internal/api/middlewares/auth.go:13-30`).
- API-key and webhook-secret previews are generated/stored in application data (`backend/internal/api/handlers/profile_handler.go:49-71`, `backend/internal/api/handlers/settings_handler.go:83-102`). API keys are not accepted by auth middleware.
- Integration `Config` is an untyped map returned through CRUD endpoints, so provider secrets placed there receive no field-level redaction (`backend/internal/models/settings.go:11-20`, `backend/internal/api/handlers/settings_handler.go:133-197`).

## 12. Tests and coverage

### Commands actually run

| Command | Result |
|---|---|
| `go build -buildvcs=false ./...` from `backend` | **PASS** |
| Temporary server smoke run on port 18082 with secret values overridden/redacted | **PASS**: Fiber initialized 182 handlers and listened until the intentional timeout |
| `go vet ./...` | **PASS** |
| `go test -json ./...` | **FLAKY FAIL** on the first run: the generated accuracy report writer assumed `backend/test-results` existed (`backend/tests/unit/semantic_and_generation_accuracy_test.go:725-739`). A second isolated run passed after another test had created the directory (`backend/tests/unit/validator_accuracy_test.go:210-236`). Parsed events: 22 package/test passes and 1 live-Gemini skip. |
| `go test -cover ./...` | **PASS**, but most production packages reported 0.0%, orchestrator reported 3.9%, and test-only packages reported no statements. A trustworthy aggregate is **NOT DETERMINABLE** from this package-level layout. |
| `npm.cmd run build` from `frontend` | **PASS**: 2,674 modules; JS bundle about 936.78 kB (283.79 kB gzip). Warnings: Axios is both static/dynamic imported and a chunk exceeds 500 kB. |
| `npm.cmd run lint` | **FAIL**: 2 errors and 1 warning—unused `useState` in `ChatToolbar`, effect-driven state update in `useChat`, and dependency warning in `useChatSessions` (`frontend/src/components/chat/ChatToolbar.jsx:1`, `frontend/src/hooks/useChat.js:18-22`, `frontend/src/hooks/useChatSessions.js:55-58`). |
| `npm.cmd exec jest -- --runInBand` | **FAIL before collection**: config requests `jest-environment-jsdom`, but it is not installed (`frontend/jest.config.js:1-6`, `frontend/package.json:1-44`). |
| Python `py_compile` plus application import | **PASS** for `backend/semantic_search_service/app.py` |

The environment used Go 1.26 against a module declaring Go 1.22 (`backend/go.mod:1-3`), Node 24.16/npm 11.1, and Python 3.13. These are not pinned by a root toolchain file or reproducible container.

### What the tests cover

- Deterministic validator allow/deny behavior, registry cases, and generated accuracy metrics (`backend/tests/unit/validator_test.go:9-23`, `backend/tests/unit/validator_accuracy_test.go:1-236`).
- Semantic retrieval/candidate generation accuracy with mocks and an opt-in live Gemini test (`backend/tests/unit/semantic_and_generation_accuracy_test.go:113-191`).
- Chat safety cases including destructive intent (`backend/internal/core/orchestrator/chat_safety_test.go:5-31`).
- Runner registration and one API integration path (`backend/tests/unit/runner_test.go:13-30`, `backend/tests/integration/api_test.go:29-108`).

### Important gaps

- No reliable frontend test run; existing test files cannot start in the checked-in dependency set.
- No Python unit/integration tests for indexing, cache invalidation, provider failures, or the unauthenticated rebuild endpoint.
- No tests found for auth password verification, refresh-token ownership, route authorization, tenant isolation, API-key auth, healing idempotency, partial external side effects, publish/restore validation, or dynamic-value threshold enforcement.
- The 5,000-case generation test uses a mock, so it validates parser/selection behavior rather than live model quality or drift.
- No end-to-end test starts frontend + Go + Python + a real MCP server/provider.
- Coverage is not enforced in CI, and no CI workflow was found in the repository map.

## 13. TODOs, dead code, and security findings

### TODO/dead or disconnected areas

An explicit source-code scan found no `TODO`, `FIXME`, or `HACK` markers. Absence of markers does not mean completion:

- Repository adapter files are comments/placeholders; all persistence remains in memory (`backend/internal/repository/workflow_repo.go:1-4`, `backend/internal/repository/audit_repo.go:1-4`, `backend/internal/repository/memory.go:13-35`).
- Ollama generation code exists but active provider selection rejects it (`backend/internal/core/synthesizer/ollama_client.go:78-134`).
- Deterministic candidate fallback/selector helpers have definitions but no callers (`backend/internal/core/synthesizer/candidates.go:440-630`).
- Frontend workflow services/hooks are mock-backed, and canvas execute/deploy handlers contain simulated waits/comments instead of backend calls (`frontend/src/hooks/useWorkflows.js:1-12`, `frontend/src/components/canvas/WorkflowBuilderCanvas.jsx:511-560`).
- Dashboard, analytics, settings/integration, admin, and several catalog views consume constant mock data or thin placeholders (`frontend/src/constants/mockData.js:3-243`, `frontend/src/pages/dashboard/DashboardPage.jsx:1-33`, `frontend/src/pages/analytics/AnalyticsPage.jsx:10-38`, `frontend/src/pages/settings/SettingsPage.jsx:1-60`).
- `VITE_WS_BASE_URL` is configured, but no backend `/ws` route was found (`frontend/src/config/app.js:4-5`, `backend/internal/api/routes/routes.go:18-153`).

### Security findings, prioritized

| Severity | Finding | Evidence / impact |
|---|---|---|
| **Critical** | Authentication accepts effectively any credentials and can yield the seeded administrator. | Login searches by email but falls back to the first seeded user and never verifies password; registration also ignores password. Refresh always returns the seeded user (`backend/internal/api/handlers/auth_handler.go:11-79`). An attacker can become admin. |
| **Critical** | Authenticated routes lack authorization enforcement. | Routes attach authentication but never the available RBAC middleware (`backend/internal/api/routes/routes.go:27-153`, `backend/internal/api/middlewares/rbac.go:8-16`). Any authenticated identity can reach admin, registry, settings, integration, workflow, execution, and audit endpoints. |
| **High** | Development bypasses are safe-by-default only by operator discipline. | Development auth defaults enabled, a fixed token is accepted, query-string tokens are allowed, and the JWT secret has a hardcoded fallback (`backend/internal/config/config.go:82-84`, `backend/internal/api/middlewares/auth.go:13-47`). Query tokens can leak in browser history and intermediaries. |
| **High** | No tenant/user ownership boundary for stored data. | Chats have no owner field, workflow reads are not filtered by authenticated owner, and the in-memory store is global (`backend/internal/models/settings.go:32-50`, `backend/internal/repository/memory.go:13-35`). |
| **High** | Healing can duplicate external writes and silently mutate workflow definitions. | Earlier MCP calls may succeed before failure; no used idempotency key or compensation exists; passing repair YAML overwrites the workflow (`backend/internal/core/runner/executor.go:38-69`, `backend/internal/api/handlers/execute_handler.go:61-87`). |
| **High** | Secrets/configuration can be exposed or logged. | Gemini key is a query parameter; integration configuration is returned unredacted; raw YAML/errors are sent to healing (`backend/internal/core/synthesizer/gemini_client.go:61-68`, `backend/internal/api/handlers/settings_handler.go:133-197`, `backend/internal/core/healing/error_loop.go:20-38`). |
| **Medium** | API keys are security theater. | Keys are generated and stored, but middleware validates only JWT/development tokens; API keys are never used for authentication (`backend/internal/api/handlers/profile_handler.go:49-71`, `backend/internal/api/middlewares/auth.go:13-47`). |
| **Medium** | Semantic service exposes expensive operations without auth. | Search, rebuild, health, and index metadata endpoints are public if the service is network-reachable (`backend/semantic_search_service/app.py:174-255`). Rebuild can cause provider and CPU/memory load. |
| **Medium** | Prompt injection/data exfiltration boundaries are weak. | User text and retrieved rule/template/example content are placed in model prompts. Deterministic validation limits known actions but does not prevent sensitive free-text from entering prompts or validate resolved runtime values (`backend/internal/core/synthesizer/candidates.go:67-193`, `backend/internal/core/validator/registry_validator.go:349-375`). |
| **Medium** | Frontend stores access and refresh tokens in local storage. | Axios reads tokens from local storage, exposing them to any successful XSS (`frontend/src/config/axios.js:12-38`). |
| **Low now / future risk** | Integration/webhook endpoints are mocks but accept untyped URLs/config. | Test/connect handlers do not make outbound requests today; if wired directly, URL validation and SSRF controls will be required (`backend/internal/api/handlers/settings_handler.go:83-212`). |

## 14. Gap analysis against `CLAUDE.md`

`CLAUDE.md` is **NOT FOUND** anywhere in the audited repository, so a literal planned-vs-implemented comparison against that file is impossible. The closest checked-in product claims are the README's contribution bullets (`README.md:49-57`); they are used below as a clearly labeled substitute.

| README claim/theme | Status | Evidence and gap |
|---|---|---|
| Retrieval-grounded synthesis | **Implemented/partial** | Typed registries, Go retrieval, Python FAISS/embedding service, and orchestration context are present (`backend/internal/core/semanticsearch/service.go:63-158`, `backend/semantic_search_service/app.py:174-255`). Default external mode fails closed unless the Python/Ollama path is running; contract/version tests are absent. |
| Multi-candidate generation | **Implemented/partial** | One Gemini call can return up to five candidates, all validated and selected (`backend/internal/core/synthesizer/candidates.go:37-64`, `backend/internal/core/orchestrator/chat_orchestrator.go:120-156`). There is no retry, actual token accounting, live quality gate, or working deterministic fallback. |
| Deterministic semantic validation | **Implemented/partial** | Strong registry gate covers key policy types (`backend/internal/core/validator/registry_validator.go:47-310`). It is optional in handler wiring, absent on several persistence/state paths, and does not revalidate resolved values. Four declared rule families lack explicit evaluators. |
| Critical-action blocking | **Implemented** for chat and normal run, **partial** system-wide | Destructive intent is blocked in orchestration and unknown/forbidden tools fail the full gate (`backend/internal/core/orchestrator/chat_orchestrator.go:83-100`, `backend/internal/core/validator/registry_validator.go:85-149`). Weak-only endpoints and direct runner use remain. |
| Role simulation/RBAC | **Partial** | Validator role checks exist, but login is not real, route RBAC is unused, and approval identities are unbound (`backend/internal/core/validator/registry_validator.go:126-135`, `backend/internal/api/handlers/auth_handler.go:11-79`). |
| Canvas/visual workflow editing | **Partial** | Drag/connect/edit interactions are substantial (`frontend/src/components/canvas/WorkflowBuilderCanvas.jsx:430-586`), while execute/deploy and much workflow data flow are simulated. |
| Self-healing | **Partial, unsafe for production** | One LLM repair can be validated and saved, but execution is not retried, no human approves mutation, and idempotency/compensation are absent (`backend/internal/core/healing/error_loop.go:11-51`, `backend/internal/api/handlers/execute_handler.go:61-87`). |
| Enterprise administration/analytics/audit | **Mocked/partial** | Broad API/UI surfaces exist, but persistence is process-local, UI pages are mock-backed, authorization is absent, and audit is mutable in-memory data (`backend/internal/repository/memory.go:13-35`, `frontend/src/constants/mockData.js:3-243`). |

## 15. Honest assessment

### Completion estimate by subsystem

These percentages measure production-ready behavior, not file count or UI surface area.

| Subsystem | Estimate | Rationale |
|---|---:|---|
| Registry ingestion and retrieval | 75% | Real typed registries, hashing, lexical/external retrieval, and FAISS caching; operational/provider and contract gaps remain. |
| LLM generation/orchestration | 60% | Real Gemini call, retrieval grounding, candidates, selection; fallback, retry, usage, conversation memory, and live confidence evidence are missing. |
| Deterministic validation | 70% | Strong static core with multiple policy types; bypassable placement and unresolved runtime values prevent it from being a complete safety boundary. |
| Execution engine | 35% | Sequential tool dispatch and logs work, but conditions, `onError`, retries, branching, cancellation, runtime policy checks, and durable state do not. |
| MCP/tool integration | 30% | Clean adapter shape and mock execution; remote protocol is a custom untyped POST, with no discovery/auth/schema negotiation. |
| Self-healing | 20% | One repair/save path exists; no retry loop, repaired rerun, HITL, idempotency, compensation, or terminal failure discipline. |
| Human-in-the-loop | 10% | Policy strings and UI concepts exist; no durable request/approve/resume workflow. |
| Persistence/data integrity | 10% | Rich models but process-local maps; no database/Redis implementation, transactions, migrations, or tenant isolation. |
| Authentication/authorization | 20% | JWT middleware and role models exist; credential verification and route authorization are effectively absent. |
| Frontend | 50% | Broad, polished navigation/canvas/chat shell; most business areas and execution workflows are mock/simulated, and tests/lint are broken. |
| Audit/observability | 25% | Request logging, execution logs, registry hashes, and in-memory audit records exist; no durable tamper resistance, metrics/traces, or real token/cost data. |
| Test/release readiness | 45% | Meaningful Go safety tests and successful builds; one order-dependent test, no usable frontend/Python suite, low production coverage, no E2E/CI. |

**Overall production-readiness estimate: 43%.** The repository is a capable research/demo prototype with a genuine registry-grounded validation core, not a production low-code workflow platform. The frontend surface and API breadth substantially exceed the amount of durable, authorized, end-to-end behavior behind them.

### Single riskiest component

**Authentication and authorization are the highest risk.** Any password can authenticate, unknown email can fall back to the seeded administrator, refresh is not tied to a principal, and protected routes do not enforce role permissions (`backend/internal/api/handlers/auth_handler.go:11-79`, `backend/internal/api/routes/routes.go:27-153`). This makes every other policy and safety claim bypassable at the application boundary.

### Next three implementation priorities

1. **Establish a real security and persistence boundary.** Verify password hashes/OIDC identities, bind refresh tokens, disable all development bypasses outside development, apply route/resource authorization, enforce ownership/tenant filters, and move users/workflows/executions/audit into transactional durable storage.
2. **Make execution semantics safe and complete.** Revalidate resolved parameters immediately before dispatch; implement conditions, retry/on-error semantics, cancellation, idempotency keys, compensations, durable step state, and a real approval pause/resume protocol before enabling non-mock MCP writes.
3. **Turn validation into a mandatory invariant and prove it end to end.** Constructor-require the registry gate, validate create/update/publish/restore/template/canvas paths, implement every rule family and typed parameter schemas, then add frontend/Python/contract/E2E tests plus CI gates for lint, tests, coverage, and secret scanning.

### Final disposition

- Suitable today for: local demonstrations, research experiments, registry/validator evaluation, and UI prototyping with controlled mock tools.
- Not suitable today for: production credentials, untrusted users, regulated workflows, multi-tenant data, or real side-effecting enterprise tools.
- Most valuable asset: the typed registry plus deterministic validation/orchestration pipeline.
- Main illusion to avoid: a passing build and broad UI/API catalog do not imply that auth, persistence, approvals, integrations, healing, or execution semantics are complete.
