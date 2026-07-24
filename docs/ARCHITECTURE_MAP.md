# Architecture Map

Reconnaissance snapshot of branch `feat/role-portals` at commit
`569b29407eb4f4592ade929959d664ff5e9f0007` on 2026-07-25. This document
describes the checked-out source; it does not propose or implement features.
The default API base path is `/api`.

## 1. Backend tree

### Directory inventory

| Directory | Purpose evidenced by contents |
|---|---|
| `backend/internal` | Private application packages. |
| `backend/internal/api` | HTTP transport layer. |
| `backend/internal/api/handlers` | Fiber handlers, authorization scope helpers, response assembly, and handler tests. |
| `backend/internal/api/middlewares` | JWT authentication, permission checks, rate limiting, request logging, and persistence-failure protection. |
| `backend/internal/api/routes` | The single Fiber route-registration table and route tests. |
| `backend/internal/authn` | Password hashing and verification. |
| `backend/internal/config` | Environment loading, path resolution, production/experiment safety validation, Redis construction, and tests. |
| `backend/internal/core` | Domain services used by handlers. |
| `backend/internal/core/healing` | LLM-assisted YAML repair wrapper. |
| `backend/internal/core/orchestrator` | Chat retrieval/generation/validation coordination, candidate selection, terminal traces, and safety tests. |
| `backend/internal/core/registry` | Tool/rule models, loaders, in-memory snapshot registries, master-file mutation manager, seed-preview isolation, and tests. |
| `backend/internal/core/runner` | Synchronous workflow executor, variable state manager, validation-token entry gate, and deferred dispatch gate. |
| `backend/internal/core/semanticsearch` | External embedding search client, lexical fallback/index, document construction, authoritative result reconciliation, and tests. |
| `backend/internal/core/synthesizer` | Gemini/Ollama/OpenAI-compatible generation clients, candidate prompt/response handling, usage extraction, and tests. |
| `backend/internal/core/validator` | Strict YAML parsing, schema/tool/RBAC/governance validation, registry hashing, validation-token signing, deferred checks, and audit decisions. |
| `backend/internal/models` | HTTP, workflow, execution, user/RBAC, settings, chat, and validation-token data shapes. |
| `backend/internal/repository` | Map-backed runtime store, built-in authorization policy, bootstrap/migrations, full-snapshot persistence hook, and tests. |
| `backend/internal/storage` | Memory/PostgreSQL backend selection, AES-GCM codec, single-row PostgreSQL state store, migrations, and tests. |
| `backend/internal/storage/migrations` | PostgreSQL `runtime_state` schema up/down migrations. |
| `backend/internal/tools` | Runtime tool interface/registry, generic MCP tool, remote/mock MCP client, and tests. |
| `backend/internal/tools/impl` | Concrete attendance and leave MCP tool adapters. |
| `backend/pkg` | Importable support packages. |
| `backend/pkg/logger` | Zap logger construction. |
| `backend/pkg/parser` | Variable interpolation and checksum helpers. |

### Files over 200 lines

Line counts are from the checked-out files, including tests.

| Lines | File | Purpose |
|---:|---|---|
| 1090 | `internal/core/validator/registry_validator.go` | Full registry gate, YAML parsing, rule evaluators, deferred runtime checks, registry/content hashes, token proof, audit evidence, scoring. |
| 636 | `internal/api/handlers/admin_handler.go` | User, role, permission, and audit administration plus authority/lockout guards. |
| 626 | `internal/core/orchestrator/chat_orchestrator.go` | End-to-end chat orchestration, destructive identity intent block, capability filtering, rule grounding, generation, validation, selection. |
| 549 | `internal/api/handlers/workflow_handler.go` | Workflow/template CRUD, validation/publish/restore, YAML/canvas handling, assignment, versioning. |
| 543 | `internal/core/semanticsearch/service.go` | External and lexical semantic retrieval, ranking, cache, and authoritative registry reconciliation. |
| 503 | `internal/repository/persistent_store.go` | Encrypted whole-store snapshot serialization, synchronous save/rollback, restore, legacy user migration. |
| 492 | `internal/core/synthesizer/candidates.go` | Candidate prompt construction, provider invocation, parsing, fallback/example selection, generation metadata. |
| 447 | `internal/core/registry/manager.go` | Strict tool/rule mutations, temp-file/backup replacement, live snapshot publication, isolated seed preview. |
| 398 | `internal/api/handlers/settings_handler.go` | Settings, integrations, webhooks, secret redaction, URL validation, outbound tests. |
| 361 | `internal/api/handlers/gate_invariant_test.go` | Cross-handler full-gate and validation-token invariants. |
| 351 | `internal/repository/persistent_store_test.go` | Persistence, rollback, encryption, normalization, and legacy migration coverage. |
| 312 | `internal/api/handlers/handler.go` | Handler dependency container and shared response/auth/body/pagination helpers. |
| 300 | `internal/config/config.go` | Environment defaults and production/experiment configuration validation. |
| 298 | `internal/core/registry/loader.go` | Master-registry and dataset folder loaders with version fingerprints. |
| 291 | `internal/core/orchestrator/terminal_reporter.go` | Human-readable terminal trace boxes for chat decisions and errors. |
| 277 | `internal/api/handlers/execute_handler.go` | Synchronous run lifecycle, validation gates, healing, execution/log/timeline APIs. |
| 264 | `internal/api/handlers/analytics_handler.go` | Runtime-derived analytics aggregates and unavailable F1 marker. |
| 259 | `internal/repository/memory.go` | Store maps, permission catalog, four built-in roles, live effective-user derivation. |
| 249 | `internal/api/handlers/chat_handler.go` | Synthesis endpoints, chat session CRUD, and orchestrator adapter. |
| 237 | `internal/api/handlers/settings_handler_test.go` | Settings secret-redaction and outbound endpoint safety tests. |
| 236 | `internal/storage/postgres.go` | PostgreSQL migration, writer-lock, load/save/probe, and cleanup. |
| 230 | `internal/api/handlers/auth_handler.go` | Login/register/refresh/logout and explicit 501 auth-feature stubs. |
| 226 | `internal/core/synthesizer/ollama_client.go` | Provider resolution/dispatch across configured generation backends. |
| 222 | `internal/config/config_test.go` | Configuration default and safety-invariant tests. |
| 222 | `internal/api/handlers/provider_handler.go` | Platform-admin-only provider CRUD/activation/test with write-only secrets. |
| 204 | `internal/api/handlers/catalog_handler.go` | Catalog, semantic service, semantic search, and canvas validation endpoints. |
| 202 | `internal/api/handlers/dashboard_handler.go` | Dashboard metrics, activity, health, and recent workflows. |

## 2. Complete HTTP and WebSocket route table

### Exact notation and common behavior

All routes pass through `G`, which is the literal application middleware chain
`cors.New -> RequestLogger -> PersistenceFailureGuard`. For a mutation backed
by PostgreSQL, `PersistenceFailureGuard` may replace the response with:

```json
{"success":false,"data":null,"message":"Storage persistence is unavailable; no mutation was committed and the request can be retried","meta":null}
```

`A` means `Auth(JWT secret)`. It accepts an `Authorization: Bearer` token; only
`/ws/*` may instead supply `?token=`. Its exact 401 messages are `Missing access
token`, `Invalid or expired access token`, `Invalid token claims`, and `Invalid
token subject`. `U` means `Handler.RequireUser`; it returns 401 `Authenticated
user no longer exists` or 403 `User account is not active`.

`P(x)` is `RequirePermission(x)`, returning
`F(403,"Permission denied",{"required":"x"})`. `PA(a,b)` is
`RequireAnyPermission([a,b])`, returning
`F(403,"Permission denied",{"requiredAny":["a","b"]})`.

`S(status,data,message,meta)` means the exact JSON envelope
`{"success":true,"data":data,"message":message,"meta":meta}`. `F` means the same
four keys with `success:false` and `data:null`. Fiber errors are converted by
the global error handler to that same failure envelope. `C` in an error cell
means the applicable exact common `A`, `U`, permission, and persistence errors
defined above. A bold route has no authentication or no permission middleware.

### Health, WebSocket, and authentication

| Method/path | Handler | Full middleware | Permission | Request body | Exact success | Handler-specific errors |
|---|---|---|---|---|---|---|
| **`GET /healthz`** | `Health` | `G` | **none; no auth** | none | `S(200,health,"OK",null)` | 503 uses `success:false`, the health data, and `Storage persistence is degraded`. |
| **`GET /api/health`** | `Health` | `G` | **none; no auth** | none | `S(200,health,"OK",null)` | Same 503 degraded response. |
| **`GET /ws/*`** | WebSocket upgrade -> `WebSocketEvents` | `G -> A -> U -> websocket.New` | **none** | handshake; optional JWT query token | 101 upgrade; then five-second `system.health.snapshot` JSON events | C; connection closes when `WriteJSON` fails. Client messages are not read. |
| **`POST /api/auth/login`** | `Login` | `G -> RateLimit(10/minute/IP/path)` | **none; no auth** | `{email,password,rememberMe}` | `S(200,AuthSession,"Login successful",null)` | F400 `Invalid request body` or `Email and password are required`; F401 `Invalid email or password`; F403 `User account is not active`; F500 `Could not sign access token`; F429 rate-limit message. |
| **`POST /api/auth/register`** | `Register` | `G -> RateLimit(10/minute/IP/path)` | **none; no auth** | `{name,email,password,organizationName}` | `S(201,AuthSession,"Registration successful",null)` | F400 invalid body/requirements; F403 `Registration is not available`; F409 duplicate email; F503 `Platform bootstrap has not completed`; F500 hash/sign/default-role errors; F429. |
| **`POST /api/auth/refresh`** | `Refresh` | `G -> RateLimit(10/minute/IP/path)` | **none; no auth** | `{refreshToken}` | `S(200,AuthSession,"Token refreshed",null)` | F400 invalid body/`Refresh token is required`; F401 `Invalid or expired refresh token`; F500 `Could not refresh token`; F429. |
| **`POST /api/auth/forgot-password`** | `ForgotPassword` | `G -> RateLimit(10/minute/IP/path)` | **none; no auth** | accepted but ignored | none | F501 `Password recovery is not configured for this installation`; F429. |
| **`POST /api/auth/reset-password`** | `ResetPassword` | `G -> RateLimit(10/minute/IP/path)` | **none; no auth** | accepted but ignored | none | F501 same password-recovery message; F429. |
| **`POST /api/auth/verify-email`** | `VerifyEmail` | `G -> RateLimit(10/minute/IP/path)` | **none; no auth** | accepted but ignored | none | F501 `Email verification is not configured for this installation`; F429. |
| **`GET /api/auth/oauth/:provider/authorize`** | `OAuthAuthorize` | `G` | **none; no auth** | none | none | F501 `OAuth is not configured for this installation`. |
| **`GET /api/auth/oauth/:provider/callback`** | `OAuthCallback` | `G` | **none; no auth** | provider callback query ignored | none | F501 same OAuth message. |
| **`POST /api/auth/logout`** | `Logout` | `G -> A -> U` | **none** | optional `{refreshToken}` | `S(200,{"loggedOut":true},"Logged out",null)` | C. |
| **`GET /api/auth/me`** | `Me` | `G -> A -> U` | **none** | none | `S(200,publicUser,"OK",null)` | C. |
| **`POST /api/auth/2fa/verify`** | `TwoFactorVerify` | `G -> A -> U` | **none** | ignored | none | C; F501 `Two-factor authentication is not configured for this installation`. |
| **`POST /api/auth/2fa/enable`** | `TwoFactorEnable` | `G -> A -> U` | **none** | ignored | none | C; same F501. |
| **`POST /api/auth/2fa/disable`** | `TwoFactorDisable` | `G -> A -> U` | **none** | ignored | none | C; same F501. |

### Dashboard and workflows

| Method/path | Handler | Full middleware | Permission | Body/query | Exact success | Handler-specific errors |
|---|---|---|---|---|---|---|
| `GET /api/dashboard/summary` | `DashboardSummary` | `G -> A -> U -> P(workflow:read)` | `workflow:read` | query `range,timezone` | `S(200,{metrics},"OK",{range,timezone})` | C. |
| `GET /api/dashboard/activity` | `DashboardActivity` | same with `P(workflow:read)` | `workflow:read` | none | `S(200,activity[],"OK",{"nextCursor":null})` | C. |
| `GET /api/dashboard/health` | `DashboardHealth` | same | `workflow:read` | none | `S(200,{overall,services},"OK",null)` | C. |
| `GET /api/dashboard/recent-workflows` | `RecentWorkflows` | same | `workflow:read` | query `limit` | `S(200,Workflow[],"OK",null)` | C. |
| `GET /api/workflows/templates` | `ListTemplates` | `G -> A -> U -> P(workflow:read)` | `workflow:read` | none | `S(200,WorkflowTemplate[],"OK",null)` | C. |
| `POST /api/workflows/templates` | `CreateTemplate` | `G -> A -> U -> P(workflow:write)` | `workflow:write` | `{name,description,category,tags,yaml,steps}` | `S(201,WorkflowTemplate,"Template created",null)` | C; no handler validation. |
| `POST /api/workflows/templates/:id/use` | `UseTemplate` | same with `P(workflow:write)` | `workflow:write` | optional `{name}` | `S(201,Workflow,"Template converted to workflow",null)` | C; F404 template; F422 YAML/full-gate validation; F500 gate error. |
| `GET /api/workflows` | `ListWorkflows` | `G -> A -> U -> PA(workflow:read,workflow:read_own)` | either | query `page,limit,q,status,sort` | `S(200,Workflow[], "OK",PaginationMeta)` filtered by ownership/assignment | C. |
| `POST /api/workflows` | `CreateWorkflow` | `G -> A -> U -> P(workflow:write)` | `workflow:write` | `CreateWorkflowRequest` | `S(201,Workflow,"Workflow created",null)` | C; F400 body/YAML required; F422 schema or full registry validation; F500 gate error. |
| `GET /api/workflows/assignable-users` | `ListAssignableWorkflowUsers` | same | `workflow:write` | none | `S(200,userSummary[],"Assignable users loaded",{"count":n})` | C. |
| `GET /api/workflows/:id` | `GetWorkflow` | `G -> A -> U -> PA(workflow:read,workflow:read_own)` | either plus object scope | none | `S(200,Workflow,"OK",null)` | C; F404 also hides out-of-scope workflow. |
| `PATCH /api/workflows/:id` | `UpdateWorkflow` | `G -> A -> U -> P(workflow:write)` | `workflow:write` | `UpdateWorkflowRequest` | `S(200,Workflow,"Workflow updated",null)` | C; F400 body; F404; F409 content changed during gate; F422 stored YAML gate failure; F500. |
| `DELETE /api/workflows/:id` | `DeleteWorkflow` | same | `workflow:write` | none | `S(200,{"deleted":true},"Workflow deleted",null)` | C; F404. |
| `POST /api/workflows/:id/duplicate` | `DuplicateWorkflow` | same | `workflow:write` | optional `{name}` | `S(201,Workflow,"Workflow duplicated",null)` | C; F404. No revalidation. |
| `POST /api/workflows/:id/publish` | `PublishWorkflow` | same | `workflow:write` | optional `{versionNote}` | `S(200,WorkflowVersion,"Workflow published",null)` | C; F404; F409 concurrent change; F422 full gate or draft-unvalidated; F500. |
| `POST /api/workflows/:id/archive` | `ArchiveWorkflow` | same | `workflow:write` | none | `S(200,{"archived":true},"Workflow archived",null)` | C; F404. |
| `POST /api/workflows/:id/validate` | `ValidateWorkflow` | `G -> A -> U -> P(workflow:read)` | `workflow:read` | optional `{yaml}` | `S(200,CandidateValidationResult,"Workflow is valid|invalid",null)` | C; F404; F500. Invalid result is still HTTP 200. |
| `POST /api/workflows/:id/run` | `RunWorkflow` | `G -> A -> U -> PA(workflow:run,workflow:run_own)` | either plus object scope | `RunWorkflowRequest` | dry run: `S(200,{can_execute,dry_run,validation,planned_steps},"Dry run validation passed",null)`; real: `S(200,Execution,"Execution completed",null)` | C; F403 assignment; F404; F422 draft/schema/full gate; F500 gate. Runtime/tool failure is represented in returned execution status, not an HTTP error. |
| `POST /api/workflows/:id/assign` | `AssignWorkflowUser` | `G -> A -> U -> P(workflow:write)` | `workflow:write` | `{userId}` | `S(200,Workflow,"User assigned to workflow",null)` | C; F400 missing userId; F404 workflow/user. |
| `DELETE /api/workflows/:id/assign/:userId` | `UnassignWorkflowUser` | same | `workflow:write` | none | `S(200,Workflow,"User unassigned from workflow",null)` | C; F404 workflow. |
| `GET /api/workflows/:id/yaml` | `GetWorkflowYAML` | `G -> A -> U -> PA(workflow:read,workflow:read_own)` | either plus scope | none | `S(200,WorkflowYAML,"OK",null)` | C; F404 hides scope. |
| `PUT /api/workflows/:id/yaml` | `PutWorkflowYAML` | `G -> A -> U -> P(workflow:write)` | `workflow:write` | `WorkflowYAML` (`yaml` used) | `S(200,WorkflowYAML,"Workflow YAML updated",null)` | C; F400 body; F404; F422 schema/full gate; F500. |
| `GET /api/workflows/:id/canvas` | `GetWorkflowCanvas` | `G -> A -> U -> PA(workflow:read,workflow:read_own)` | either plus scope | none | `S(200,WorkflowCanvas,"OK",null)` | C; F404 hides scope. |
| `PUT /api/workflows/:id/canvas` | `PutWorkflowCanvas` | `G -> A -> U -> P(workflow:write)` | `workflow:write` | `WorkflowCanvas` | `S(200,WorkflowCanvas,"Workflow canvas updated",null)` | C; F400 body; F404. Semantic edits mark workflow `draft-unvalidated`; no validation is run. |
| `GET /api/workflows/:id/versions` | `WorkflowVersions` | `G -> A -> U -> PA(workflow:read,workflow:read_own)` | either plus scope | none | `S(200,WorkflowVersion[],"OK",null)` | C; F404 hides scope. |
| `POST /api/workflows/:id/restore/:versionId` | `RestoreWorkflowVersion` | `G -> A -> U -> P(workflow:write)` | `workflow:write` | none | `S(200,Workflow,"Workflow restored",null)` | C; F404 workflow/version; F409 version changed; F422 full gate; F500. |
| `GET /api/workflows/:id/executions` | `WorkflowExecutions` | `G -> A -> U -> PA(workflow:read,workflow:read_own)` | either plus workflow/execution scope | query `page,limit` | `S(200,Execution[],"OK",PaginationMeta)` | C; F404 hides scope. |

### Synthesis, catalogs, semantic index, canvas, and registry

| Method/path | Handler | Full middleware | Permission | Body/query | Exact success | Handler-specific errors |
|---|---|---|---|---|---|---|
| `POST /api/synthesis` | `Synthesize` | `G -> A -> U -> P(workflow:write)` | `workflow:write` | `{prompt,mode,model,context}` | `S(200,{yaml,confidence,workflowDraft,validation,flowPreview,usage},"Workflow draft generated",null)` | C; F400 prompt; F502 provider error. Uses basic validator, not full registry gate. |
| `POST /api/synthesis/validate` | `SynthesisValidate` | `G -> A -> U -> P(workflow:read)` | `workflow:read` | `{yaml}` | `S(200,CandidateValidationResult,"Workflow is valid|invalid",null)` | C; F500 gate. Invalid is HTTP 200. |
| `POST /api/synthesis/preview-flow` | `SynthesisPreviewFlow` | same | `workflow:read` | `{yaml}` | `S(200,WorkflowCanvas,"Flow preview generated",null)` | C; F422 `Cannot preview invalid YAML`. |
| `POST /api/synthesis/explain` | `SynthesisExplain` | same | `workflow:read` | `{yaml}` | `S(200,{summary,steps},"Explanation generated",null)` | C; F422 `Cannot explain invalid YAML`. |
| `GET /api/tools/catalog` | `ToolsCatalog` | same | `workflow:read` | query `module,role,status` | `S(200,toolSummary[],"Tool catalog loaded",{"count":n})` | C; F503 registry not loaded. |
| `GET /api/rules/catalog` | `RulesCatalog` | same | `workflow:read` | query `domain,enabled` | `S(200,ruleSummary[],"Rule catalog loaded",{"count":n})` | C; F503 registry not loaded. |
| `POST /api/semantic-search` | `SemanticSearch` | same | `workflow:read` | `{query,top_k_tools,top_k_rules,top_k_templates,top_k_examples}` | `S(200,semanticsearch.Result,"Semantic search completed",null)` | C; F400 query; F502 search error; F503 not configured. |
| `GET /api/semantic-index/health` | `SemanticServiceHealth` | same | `workflow:read` | none | `S(200,externalPayload,"Semantic search service health loaded",null)` | C; F503 missing/unavailable service. |
| `GET /api/semantic-index/metadata` | `SemanticIndexMetadata` | same | `workflow:read` | none | `S(200,externalPayload,"Semantic index metadata loaded",null)` | C; F503 missing/unavailable service. |
| `POST /api/semantic-index/rebuild` | `RebuildSemanticIndex` | `G -> A -> U -> P(settings:manage)` | `settings:manage` | none | `S(200,externalPayload,"Semantic index rebuilt",null)` | C; F502 external error; F503 not configured. |
| `POST /api/canvas/validate-workflow` | `CanvasValidateWorkflow` | `G -> A -> U -> P(workflow:read)` | `workflow:read` | `{yaml}` | `S(200,{validation,step_errors},"Canvas workflow validation completed",null)` | C; F422 exact `CANVAS_CONVERSION_NOT_IMPLEMENTED` meta when YAML absent; F500 gate. |
| `GET /api/registry/tools` | `AdminToolsRegistry` | `G -> A -> U -> P(registry:read)` | `registry:read` | none | `S(200,Tool[],"Tool registry loaded",{"count":n,"registryHash":hash})` | C; F503 manager missing. |
| `POST /api/registry/tools` | `CreateRegistryTool` | `G -> A -> U -> P(registry:write) -> requireRegistryWrite` | `registry:write` plus handler Platform Admin authority | exact strict `Tool` JSON | `S(201,MutationResult<Tool>,"Tool schema created",null)` | C; F403 `Registry writes require Platform Admin authority`; F409 duplicate; F422 schema/path/persistence errors. |
| `PUT /api/registry/tools/:id` | `UpdateRegistryTool` | same | same | strict `Tool`; path must equal `tool_id` | `S(200,MutationResult<Tool>,"Tool schema updated",null)` | C; F403; F404; F409 duplicate; F422. |
| `GET /api/registry/rules` | `AdminRulesRegistry` | `G -> A -> U -> P(registry:read)` | `registry:read` | none | `S(200,Rule[],"Rule registry loaded",{"count":n,"registryHash":hash})` | C; F503 manager missing. |
| `POST /api/registry/rules` | `CreateRegistryRule` | `G -> A -> U -> P(registry:write) -> requireRegistryWrite` | `registry:write` plus Platform Admin authority | exact strict `Rule` JSON | `S(201,MutationResult<Rule>,"Rule created",null)` | C; F403; F409 duplicate; F422. |
| `PUT /api/registry/rules/:id` | `UpdateRegistryRule` | same | same | strict `Rule`; path must equal `rule_id` | `S(200,MutationResult<Rule>,"Rule updated",null)` | C; F403; F404; F422. |

### Chat, execution, and analytics

| Method/path | Handler | Full middleware | Permission | Body/query | Exact success | Handler-specific errors |
|---|---|---|---|---|---|---|
| `GET /api/chat/sessions` | `ListChatSessions` | `G -> A -> U -> PA(workflow:read,chat:use)` | either plus session scope | query `page,limit` | `S(200,ChatSession[],"OK",PaginationMeta)` | C. |
| `POST /api/chat/sessions` | `CreateChatSession` | `G -> A -> U -> PA(workflow:write,chat:use)` | either | optional `{title}` | `S(201,ChatSession,"Chat session created",null)` | C. |
| `GET /api/chat/sessions/:id` | `GetChatSession` | `G -> A -> U -> PA(workflow:read,chat:use)` | either plus scope | none | `S(200,ChatSessionDetail,"OK",null)` | C; F404 hides scope. |
| `PATCH /api/chat/sessions/:id` | `UpdateChatSession` | `G -> A -> U -> PA(workflow:write,chat:use)` | either plus scope | optional `{title}` | `S(200,ChatSession,"Chat session updated",null)` | C; F404 hides scope. |
| `DELETE /api/chat/sessions/:id` | `DeleteChatSession` | same | either plus scope | none | `S(200,{"deleted":true},"Chat session deleted",null)` | C; F404 hides scope. |
| `POST /api/chat/sessions/:id/messages` | `SendChatMessage` | same | either plus scope | `{content|message,model,mode,generate_candidates,top_k_*,dry_run}` | `S(200,{userMessage,assistantMessage,retrieval,candidates,selected_*,can_execute,validation_summary,blocking_errors,next_action},"Message processed",null)` | C; F400 message; F404 scope; F502 orchestration; F503 orchestrator missing. |
| `GET /api/executions` | `ListExecutions` | `G -> A -> U -> PA(workflow:read,execution:read_own)` | either plus object scope | query `page,limit,workflowId,status,q,range` | `S(200,Execution[],"OK",PaginationMeta)` | C. |
| `GET /api/executions/:id` | `GetExecution` | same | either plus scope | none | `S(200,Execution,"OK",null)` | C; F404 hides scope. |
| `GET /api/executions/:id/logs` | `ExecutionLogs` | same | either plus scope | none | `S(200,ExecutionLog[],"OK",{"nextCursor":null})` | C; F404 hides scope. |
| `GET /api/executions/:id/timeline` | `ExecutionTimeline` | same | either plus scope | none | `S(200,ExecutionStep[],"OK",null)` | C; F404 hides scope. |
| `GET /api/executions/:id/healing-report` | `ExecutionHealingReport` | same | either plus scope | none | `S(200,HealingReport,"OK",null)`; synthesizes `NO_HEALING_REQUIRED` if absent | C; F404 hides scope. |
| `POST /api/executions/:id/cancel` | `CancelExecution` | `G -> A -> U -> P(workflow:run)` | `workflow:run` | ignored | none | C; F501 `Cancellation is unavailable while executions run synchronously`. |
| `POST /api/executions/:id/retry` | `RetryExecution` | same | `workflow:run` | `RunWorkflowRequest` (parse errors ignored) | same as run endpoint | C; F404 prior execution/workflow; run-specific errors. |
| `GET /api/analytics/summary` | `AnalyticsSummary` | `G -> A -> U -> P(workflow:read)` | `workflow:read` | query `range` | `S(200,summary,"OK",{"range":...})` | C. |
| `GET /api/analytics/performance` | `AnalyticsPerformance` | same | `workflow:read` | none | `S(200,daily[],"OK",{"interval":"day"})` | C. |
| `GET /api/analytics/usage` | `AnalyticsUsage` | same | `workflow:read` | none | `S(200,daily[],"OK",{"currency":"USD"})` | C. |
| `GET /api/analytics/self-healing` | `AnalyticsSelfHealing` | same | `workflow:read` | none | `S(200,healingAggregate,"OK",null)` | C. |
| `GET /api/analytics/latency` | `AnalyticsLatency` | same | `workflow:read` | none | `S(200,buckets[],"OK",null)` | C. |
| `GET /api/analytics/f1-score` | `AnalyticsF1Score` | same | `workflow:read` | none | `S(200,{available:false,score:null,...},"No runtime validation benchmark has been recorded",null)` | C. |
| `GET /api/analytics/activity-heatmap` | `AnalyticsActivityHeatmap` | same | `workflow:read` | none | `S(200,days[],"OK",{"timezone":"UTC"})` | C. |
| `GET /api/analytics/cost-trends` | `AnalyticsCostTrends` | same | `workflow:read` | none | `S(200,daily[],"OK",{"interval":"day"})` | C. |

### Users, roles, permissions, and audit

| Method/path | Handler | Full middleware | Permission | Body/query | Exact success | Handler-specific errors |
|---|---|---|---|---|---|---|
| `GET /api/users` | `ListUsers` | `G -> A -> U -> P(user:manage)` | `user:manage` | query `page,limit,q,role,status` | `S(200,publicUser[],"OK",PaginationMeta)` | C. |
| `POST /api/users` | `CreateUser` | same | `user:manage` | `{name,email,password,roleId?}` | `S(201,publicUser,"User created",null)` | C; F400 fields/role; F403 role/permission grant; F409 email; F500 hashing. |
| `POST /api/users/invite` | `InviteUser` | same | `user:manage` | ignored | none | C; F501 `Email invitations is not configured for this installation`. |
| `GET /api/users/:id` | `GetUser` | same | `user:manage` | none | `S(200,publicUser,"OK",null)` | C; F404. |
| `PATCH /api/users/:id` | `UpdateUser` | same | `user:manage` | `{name?,roleId?,status?}` | `S(200,publicUser,"User updated",null)` | C; exact 400/403/404/409 authority, own-account, role, and last-admin failures described in Section 9. |
| `PUT /api/users/:id/role` | `UpdateUserRole` | same | `user:manage` | `{roleId}` | same update success | C; F400 missing/unknown role; F403 target outranks/administrator/assign/grant; F404; F409 own role or last active Platform Admin. |
| `PUT /api/users/:id/status` | `UpdateUserStatus` | same | `user:manage` | `{status:"active|suspended"}` | same update success | C; F400 missing/invalid status; F403 target outranks/administrator; F404; F409 own deactivation or last active Platform Admin. |
| `DELETE /api/users/:id` | `DeleteUser` | same | `user:manage` | none | `S(200,{"deleted":true},"User deleted",null)` | C; F403 administrator; F404; F409 own account/last Platform Admin. |
| `POST /api/users/:id/activate` | `ActivateUser` | same | `user:manage` | none | `S(200,publicUser,"User status updated",null)` | C; F403 administrator; F404. |
| `POST /api/users/:id/suspend` | `SuspendUser` | same | `user:manage` | none | same | C; F403 administrator; F404; F409 own/last active Platform Admin. |
| `GET /api/roles` | `ListRoles` | same | `user:manage` | none | `S(200,Role[],"OK",null)` | C. |
| `POST /api/roles` | `CreateRole` | same plus handler `canManageRoles` | `user:manage` and built-in admin role | `{name,description?,permissions}` | `S(201,Role,"Role created",null)` | C; F400 name/unknown permission; F403 manage/grant; F409 duplicate name. |
| `GET /api/roles/:id` | `GetRole` | `G -> A -> U -> P(user:manage)` | `user:manage` | none | `S(200,Role,"OK",null)` | C; F404. |
| `PUT /api/roles/:id` | `UpdateRole` | same plus handler role authority/floors | `user:manage` and built-in admin role | `{name?,permissions?}` | `S(200,Role,"Role updated",null)` | C; F400 unknown permission; F403 manage/System Admin/remove-or-grant-unheld; F404; F409 duplicate name/Platform Admin floor. |
| `PATCH /api/roles/:id` | `UpdateRole` | same | same | same | same | same. |
| `DELETE /api/roles/:id` | `DeleteRole` | same plus handler role authority | same | none | `S(200,{"deleted":true},"Role deleted",null)` | C; F403 manage; F404; F409 built-in or in-use (holders in meta). |
| `GET /api/permissions` | `ListPermissions` | `G -> A -> U -> P(user:manage)` | `user:manage` | none | `S(200,Permission[],"OK",null)` | C. |
| `GET /api/permissions/matrix` | `PermissionMatrix` | same | `user:manage` | none | `S(200,matrix[],"OK",null)` | C. |
| `GET /api/audit/export` | `ExportAudit` | `G -> A -> U -> P(audit:read)` | `audit:read` | query `format=csv|json,page,limit` | CSV: raw `text/csv`; otherwise list envelope | C. |
| `GET /api/audit` | `ListAudit` | same | `audit:read` | query `page,limit` | `S(200,AuditLog[],"OK",PaginationMeta)` | C. |
| `GET /api/audit/:id` | `GetAudit` | same | `audit:read` | none | `S(200,AuditLog,"OK",null)` | C; F404. |

### Profile, settings, providers, integrations, notifications, and uploads

| Method/path | Handler | Full middleware | Permission | Body/query | Exact success | Handler-specific errors |
|---|---|---|---|---|---|---|
| **`GET /api/profile`** | `GetProfile` | `G -> A -> U` | **none** | none | `S(200,Profile,"OK",null)` | C. |
| **`PATCH /api/profile`** | `UpdateProfile` | `G -> A -> U` | **none** | `{name?,timezone?}` | `S(200,Profile,"OK",null)` | C. |
| **`PATCH /api/profile/security`** | `UpdateSecurity` | `G -> A -> U` | **none** | ignored | none | C; F501 `Security preference changes is not configured for this installation`. |
| **`GET /api/profile/notifications`** | `GetNotificationPreferences` | `G -> A -> U` | **none** | none | `S(200,NotificationPreferences,"OK",null)` | C. |
| **`PATCH /api/profile/notifications`** | `UpdateNotificationPreferences` | `G -> A -> U` | **none** | `NotificationPreferences` | `S(200,NotificationPreferences,"Notification preferences updated",null)` | C; F400 body. |
| `GET /api/profile/api-keys` | `ListAPIKeys` | `G -> A -> U -> P(settings:manage)` | `settings:manage` | none | `S(200,apiKeyView[],"OK",null)` | C. Keys are global, not filtered by owner. |
| `POST /api/profile/api-keys` | `CreateAPIKey` | same | `settings:manage` | `{name,scopes}` | `S(201,createdAPIKeyView,"API key created. Store the key now; it will not be shown again.",null)` | C. |
| `DELETE /api/profile/api-keys/:id` | `DeleteAPIKey` | same | `settings:manage` | none | `S(200,{"revoked":true},"API key revoked",null)` | C; absent IDs also report success. |
| `GET /api/settings` | `GetSettings` | `G -> A -> U -> P(settings:manage)` | `settings:manage` | none | `S(200,redacted SettingsBundle,"OK",null)` | C. |
| `PATCH /api/settings` | `PatchSettings` | same | `settings:manage` | `{general?,llm?,rbac?}` | `S(200,redacted SettingsBundle,"Settings updated",null)` | C. |
| `GET /api/settings/general` | `GetGeneralSettings` | same | `settings:manage` | none | `S(200,redacted map,"OK",null)` | C. |
| `PATCH /api/settings/general` | `PatchGeneralSettings` | same | `settings:manage` | arbitrary map | `S(200,redacted map,"General settings updated",null)` | C. |
| `GET /api/settings/llm` | `GetLLMSettings` | same | `settings:manage` | none | `S(200,redacted map,"OK",null)` | C. |
| `PATCH /api/settings/llm` | `PatchLLMSettings` | same | `settings:manage` | arbitrary map | `S(200,redacted map,"LLM settings updated",null)` | C. |
| `GET /api/providers` | `ListProviders` | `G -> A -> U -> P(provider:manage) -> requirePlatformAdmin` | `provider:manage` and Platform Admin role | none | `S(200,providerConfigView[],"Provider configurations loaded",{"count":n})` | C; F403 `Provider configuration is restricted to Platform Admins`. |
| `POST /api/providers` | `CreateProvider` | same | same | `{name,type,baseUrl,model,apiKey}` | `S(201,providerConfigView,"Provider configuration created",null)` | C; F403; F409 name; F422 exact field/type/URL requirements. |
| `PUT /api/providers/:id` | `UpdateProvider` | same | same | same; blank key retains prior key | `S(200,providerConfigView,"Provider configuration updated",null)` | C; F403; F404; F409; F422. |
| `POST /api/providers/:id/activate` | `ActivateProvider` | same | same | none | `S(200,providerConfigView,"Provider activated",null)` | C; F403; F404. |
| `POST /api/providers/:id/test` | `TestProvider` | same | same | none | always `S(200,{ok,message},"Provider connection test completed",null)` for connection result | C; F403; F404; F503 synthesis service. |
| `GET /api/settings/rbac` | `GetRBACSettings` | `G -> A -> U -> P(settings:manage)` | `settings:manage` | none | `S(200,redacted map,"OK",null)` | C. |
| `PATCH /api/settings/rbac` | `PatchRBACSettings` | same | `settings:manage` | arbitrary map | `S(200,redacted map,"RBAC settings updated",null)` | C. |
| `GET /api/settings/webhooks` | `ListWebhooks` | same | `settings:manage` | none | `S(200,Webhook[],"OK",null)` | C. |
| `POST /api/settings/webhooks` | `CreateWebhook` | same | `settings:manage` | `{name,url,events}` | `S(201,Webhook,"Webhook created",null)` | C; F400 name/URL. |
| `PATCH /api/settings/webhooks/:id` | `UpdateWebhook` | same | `settings:manage` | `{name?,url?,events?,enabled?}` | `S(200,Webhook,"Webhook updated",null)` | C; F400 URL; F404. |
| `DELETE /api/settings/webhooks/:id` | `DeleteWebhook` | same | `settings:manage` | none | `S(200,{"deleted":true},"Webhook deleted",null)` | C; absent IDs also succeed. |
| `POST /api/settings/webhooks/:id/test` | `TestWebhook` | same | `settings:manage` | none | `S(200,probeResult,"Webhook test delivered",null)` | C; F404; F500 encode; F502 `Webhook delivery failed` with error meta. |
| `GET /api/integrations` | `ListIntegrations` | `G -> A -> U -> P(settings:manage)` | `settings:manage` | none | `S(200,redacted Integration[],"OK",null)` | C. |
| `POST /api/integrations` | `CreateIntegration` | same | `settings:manage` | `{name,type,config?}` | `S(201,redacted Integration,"Integration created",null)` | C; F400 fields. |
| `GET /api/integrations/:id` | `GetIntegration` | same | `settings:manage` | none | `S(200,redacted Integration,"OK",null)` | C; F404. |
| `PATCH /api/integrations/:id` | `UpdateIntegration` | same | `settings:manage` | `{status?,config?}` | `S(200,redacted Integration,"Integration updated",null)` | C; F404. |
| `DELETE /api/integrations/:id` | `DeleteIntegration` | same | `settings:manage` | none | `S(200,{"deleted":true},"Integration deleted",null)` | C; absent IDs also succeed. |
| `POST /api/integrations/:id/test` | `TestIntegration` | same | `settings:manage` | none | `S(200,probeResult,"Integration test passed",null)` | C; F404; F502 `Integration test failed` with error/time meta. |
| `POST /api/integrations/:id/connect` | `ConnectIntegration` | same | `settings:manage` | none | `S(200,redacted Integration,"Integration status updated",null)` | C; F404; F502 `Integration could not be connected`. |
| `POST /api/integrations/:id/disconnect` | `DisconnectIntegration` | same | `settings:manage` | none | same success | C; F404. |
| **`GET /api/notifications`** | `ListNotifications` | `G -> A -> U` | **none** | query `page,limit,unreadOnly` | `S(200,Notification[],"OK",PaginationMeta)` | C. Notifications are not owner-filtered. |
| **`PATCH /api/notifications/read-all`** | `MarkAllNotificationsRead` | `G -> A -> U` | **none** | none | `S(200,{"updated":true},"All notifications marked read",null)` | C. Mutates all users' notifications. |
| **`PATCH /api/notifications/:id/read`** | `MarkNotificationRead` | `G -> A -> U` | **none** | none | `S(200,Notification,"Notification marked read",null)` | C; F404. No owner check. |
| **`DELETE /api/notifications/:id`** | `DeleteNotification` | `G -> A -> U` | **none** | none | `S(200,{"deleted":true},"Notification deleted",null)` | C; no owner/existence check. |
| `POST /api/upload` | `Upload` | `G -> A -> U -> P(workflow:write)` | `workflow:write` | multipart `file` | `S(201,UploadedFile,"Upload complete",null)` | C; F400 file/open/read. No size/type limit. |
| `GET /api/upload/:id` | `GetUpload` | `G -> A -> U -> P(workflow:read)` | `workflow:read` | none | `S(200,UploadedFile,"OK",null)` | C; F404. |
| `GET /api/upload/:id/download` | `DownloadUpload` | same | `workflow:read` | none | raw stored bytes with stored MIME and attachment name | C; F404. |
| `DELETE /api/upload/:id` | `DeleteUpload` | `G -> A -> U -> P(workflow:write)` | `workflow:write` | none | `S(200,{"deleted":true},"Upload deleted",null)` | C; absent IDs also succeed. |
| `POST /api/upload/workflow-import` | `ImportWorkflow` | same | `workflow:write` | form or JSON `{yaml}` | `S(200,{workflow:{id,name,status},validation},"Workflow imported",null)` | C; F400 YAML; F422 schema/full gate; F500. |

## 3. Frontend tree and runtime surface

### Directory inventory

| Directory under `frontend/src` | Purpose/reality |
|---|---|
| `assets` | Asset namespace; currently contains only empty subdirectories. |
| `assets/animations` | Empty animation asset directory. |
| `assets/fonts` | Empty font asset directory; Open Sans is fetched by CSS from Google Fonts. |
| `assets/icons` | Empty icon asset directory; icons come from Iconify/Lucide packages. |
| `assets/images` | Empty image asset directory. |
| `assets/logo` | Empty logo asset directory. |
| `components` | Feature and shared React components. |
| `components/analytics` | Recharts-based metric/chart components. |
| `components/canvas` | Current XYFlow builder plus older canvas conversion/display controls. |
| `components/canvas/edges` | Default and conditional React Flow edge renderers. |
| `components/canvas/nodes` | Trigger/action/condition/loop/healing/note/end node renderers. |
| `components/canvas/panels` | Validation and YAML preview panels. |
| `components/chat` | Chat history/window/input/message, artifacts, suggestions, and previews. |
| `components/dashboard` | Dashboard metrics, activity, health, recent workflows, quick actions. |
| `components/executions` | Execution rows/table/filters, recorded logs, timeline, and healing report. |
| `components/navigation` | Sidebar/topbar/breadcrumb/mobile navigation/command palette. |
| `components/settings` | API key, integration, LLM selector, webhook form. |
| `components/shared` | Cross-feature resource-state components. |
| `components/shared/feedback` | Loading/error/success feedback primitives. |
| `components/shared/forms` | Form field, search, upload, and date-range controls. |
| `components/shared/tables` | Table shell, header, filter, pagination, skeleton. |
| `components/shared/ui` | Generic UI primitives listed below. |
| `components/users` | User table/forms, role creation/editing, permissions, audit. |
| `components/workflows` | Workflow cards/table/actions/filters/templates/assignments. |
| `config` | App URLs, axios, query client, i18n, sentry placeholders, route projection. |
| `constants` | API/navigation/permission/route/theme/node/status constants and tests. |
| `context` | Auth, canvas, notifications, state-route, and theme providers. |
| `hooks` | React Query and browser utility hooks listed below. |
| `layouts` | App, admin, auth, fullscreen, and print wrappers. |
| `locales` | Translation JSON namespace. |
| `locales/en` | English analytics/auth/common/error/workflow strings. |
| `locales/si` | Sinhala common strings only. |
| `pages` | Page components. |
| `pages/analytics` | Aggregate analytics plus separate performance/usage/healing pages; `App` uses `AnalyticsPage`. |
| `pages/auth` | Login/register/recovery/reset/verify/2FA/OAuth pages; only login/register/forgot are reachable from `AuthRouter`. |
| `pages/chat` | Chat, history, and session pages; `App` maps both chat states to `ChatPage`. |
| `pages/dashboard` | Dashboard and Overview pages; `App` maps both dashboard states to `DashboardPage`. |
| `pages/datafeed` | Semantic service overview, metadata metrics, and configuration. |
| `pages/errors` | Maintenance, 404, 500, and unauthorized pages. |
| `pages/executions` | List/detail/log pages; active mappings use list and logs. |
| `pages/finetune` | Semantic dataset search page. |
| `pages/mcp_bridge` | MCP configuration/health presentation. |
| `pages/models` | Provider configuration UI. |
| `pages/profile` | Profile plus separate API key/notification/security files; active mappings use `ProfilePage`. |
| `pages/registry` | Tool/rule master registry editor and semantic rebuild action. |
| `pages/settings` | Aggregate settings plus separate billing/general/integration/LLM/RBAC/webhook files; active mappings use `SettingsPage`. |
| `pages/users` | Aggregate user admin plus separate audit/role/detail/invite files; active mappings use `UserListPage`. |
| `pages/workflows` | List/detail/builder/templates/new pages. |
| `services` | Axios adapters for every backend domain. |
| `store` | Six small Zustand stores; search shows no imports outside their own files. |
| `styles` | Global Tailwind layers, theme, typography, motion, canvas, Markdown CSS. |
| `tests` | Test mocks and unit tests. |
| `tests/__mocks__` | Axios, React Flow, and CSS mocks. |
| `tests/e2e` | Empty; no browser E2E suite. |
| `tests/unit` | Unit-test hierarchy. |
| `tests/unit/hooks` | Workflow normalization test. |
| `tests/unit/utils` | Flow and YAML utility tests. |
| `types` | JavaScript/JSDoc type declarations for API/auth/execution/user/workflow. |
| `utils` | Formatting, auth, permissions, flow/canvas/YAML conversion, validation, export, storage. |

### Routing reality

There is no React Router tree, no browser URL matching, and no dynamic import.
`react-router-dom` is installed but not imported. `RouteContext` persists
`activeMain`, `activeSub`, and `selectedWorkflowId` in `localStorage`; `App.jsx`
selects an eagerly imported component from this exact map:

| State route | Component | Frontend permission gate |
|---|---|---|
| `dashboard.overview` | `DashboardPage` | `workflow:read` |
| `dashboard.activity` | `DashboardPage` | `workflow:read` |
| `workflows.list` | `WorkflowListPage` | `workflow:read` or `workflow:read_own` |
| `workflows.builder` | `WorkflowBuilderPage` | `workflow:write` |
| `workflows.templates` | `WorkflowTemplatePage` | `workflow:read` |
| `workflows.detail` | `WorkflowDetailPage` | `workflow:read` or `workflow:read_own` |
| `chat.session` | `ChatPage` | `chat:use` or `workflow:write` |
| `chat.history` | `ChatPage` | `chat:use` or `workflow:write` |
| `executions.history` | `ExecutionListPage` | `workflow:read` or `execution:read_own` |
| `executions.live` | `ExecutionLogsPage` | `workflow:read` or `execution:read_own` |
| `executions.healing` | `ExecutionLogsPage` | `workflow:read` or `execution:read_own` |
| `analytics.performance` | `AnalyticsPage` | `workflow:read` |
| `analytics.usage` | `AnalyticsPage` | `workflow:read` |
| `analytics.healing` | `AnalyticsPage` | `workflow:read` |
| `users.directory` | `UserListPage` | `user:manage` |
| `users.roles` | `UserListPage` | `user:manage` |
| `users.audit` | `UserListPage` | `audit:read` |
| `settings.general` | `SettingsPage` | `settings:manage` |
| `settings.integrations` | `SettingsPage` | `settings:manage` |
| `settings.llm` | `SettingsPage` | `settings:manage` |
| `profile.profile` | `ProfilePage` | none |
| `profile.security` | `ProfilePage` | none |
| `models.overview` | `ModelsPage` | `provider:manage` |
| `registry.overview` | `RegistryPage` | `registry:read` |
| `mcp_bridge.overview` | `McpBridgePage` | `workflow:read` |
| `datafeed.overview` | `DatafeedPage` | `workflow:read` |
| `datafeed.metrics` | `VectorMetricsPage` | `workflow:read` |
| `datafeed.config` | `PipelineConfigPage` | `workflow:read` |
| `finetune.overview` | `FinetunePage` | `workflow:read` |

Unauthenticated routing is an internal `screen` state with only `login`,
`register`, and `forgot-password`. Reset, verify-email, 2FA, and OAuth callback
page files are not reachable through `App`.

The frontend permission checks hide/replace views; backend middleware and
handler checks remain authoritative.

### Contexts

| Context | Exposed state/actions |
|---|---|
| `AuthContext` | `user`, `isAuthenticated`, `loading`, `authError`, `login`, `register`, `logout`, `refreshUser`, `clearError`; validates a stored token using `/auth/me` and listens for `auth:expired`. |
| `CanvasContext` | `nodes`, selected node/id, setters; no imports outside its file. |
| `NotificationContext` | in-memory toast list and `notify(message,tone,action)` with a 3.4-second timeout. |
| `RouteContext` | active main/sub state, navigation methods, selected workflow, `openWorkflow`, `startWorkflow`; localStorage-backed. |
| `ThemeContext` | dark-mode state, theme name, toggle; toggles `html.dark` and persists `theme`. |

### Hooks

| Hook | Purpose/reality |
|---|---|
| `useAnalytics()` | Loads all analytics endpoints through one React Query. |
| `useAuth()` | Thin `AuthContext` alias. |
| `useChat(sessionId)` | Loads one session, sends a message, appends returned messages, exposes latest artifact; catches send failure and returns `null` while retaining mutation error. |
| `useChatSessions()` | Lists/selects/creates/renames/deletes chat sessions. |
| `useClickOutside(ref,fn)` | Document `mousedown` listener. |
| `useCommandPalette()` | Local open/close state. |
| `useCopyToClipboard()` | Clipboard write and 1.2-second copied state. |
| `useDashboard()` | Loads dashboard every 30 seconds. |
| `useDebounce(value,250)` | Timeout-based debouncing. |
| `useExecution(executionId,params)` | Loads list, then logs/timeline/healing for selected execution; only list loading/error controls page state. |
| `useKeyboardShortcut(key,fn)` | Window keydown listener. |
| `useLiveLog(executionId)` | Polls execution logs every two seconds; not imported by a component. |
| `useLocalStorage(key,initial)` | JSON localStorage state. |
| `useMediaQuery(query)` | `matchMedia` subscription. |
| `useNotifications()` | Notification context alias. |
| `usePagination(items,10)` | Client-side slicing. |
| `usePermissions()` | Effective-user permission and role helpers. |
| `useSemanticStatus()` | Semantic index polling every 30 seconds. |
| `useSettings()` | Loads aggregate settings. |
| `useTheme()` | Theme context alias. |
| `useUsers()` | Loads users/roles/permissions/matrix/audit together. |
| `useWebSocket(channel)` | Opens authenticated `/ws/{channel}`, parses last event, can send; no reconnection; not imported by a component. |
| `useWorkflowBuilder(initialNodes)` | Local nodes/addNode helper; not imported. |
| `useWorkflows(params)` / `useWorkflow(id)` | Workflow list/detail React Queries and active filtering. |

### Styling proof

- `main.jsx` imports `globals.css`, `theme.css`, `typography.css`,
  `animations.css`, `flow.css`, and `markdown.css`.
- `globals.css` contains `@tailwind base`, `@tailwind components`, and
  `@tailwind utilities`, and defines `.surface-panel`, `.soft-panel`,
  `.icon-button`, `.section-title`, and `.section-subtitle` with `@apply`.
- `tailwind.config.js` scans `index.html` and `src/**/*.{js,jsx,ts,tsx}`,
  uses class-based dark mode, defines the `#84006A` primary color and workflow
  status colors, and adds a scrollbar-hide utility.
- `postcss.config.js` enables `tailwindcss` and `autoprefixer`.
- Components use Tailwind utility strings directly. XYFlow also imports
  `@xyflow/react/dist/style.css`.
- Open Sans is imported over the network in `globals.css`; no local font files
  exist in `src/assets/fonts`.

### Shared components and props

| Component | Props/defaults |
|---|---|
| `LoadingState` | `label="Loading data…"` |
| `ErrorState` | `error,onRetry` |
| `EmptyState` (`ResourceState`) | `title,description` |
| `InlineError` | `children` |
| `LoadingOverlay` | none |
| `PageLoader` | none |
| `SuccessBanner` | `children` |
| `DateRangePicker` | none |
| `FileUpload` | none |
| `FormField` | `label,error,children` |
| `SearchBar` | arbitrary input props |
| `DataTable` | `columns,rows,renderCell` |
| `TableFilters` | none |
| `TableHeader` | `title,action` |
| `TablePagination` | `page=1,pageCount=1,onPageChange` |
| `TableSkeleton` | none |
| `Accordion` | `title,children` |
| `Alert` | `children,tone="info"` |
| `Avatar` | `initials="AW",className=""` |
| `Badge` | `children,className=""` |
| `Button` | `children,variant="primary",className="",type="button",...props` |
| `Card` | `children,className="",as="section",...props` |
| `Checkbox` | `label,...props` |
| `CodeBlock` | `code` |
| `ConfirmDialog` | `open,title="Confirm action",onConfirm,children` |
| `CopyButton` | `value` |
| `Divider` | none |
| `Drawer` | `children,open=false` |
| `Dropdown` | `options=[]` |
| `EmptyState` (`ui`) | `icon="mdi:database-off-outline",title,description` |
| `Input` | `className="",...props` |
| `Modal` | `title,children,open=false` |
| `Progress` | `value=0,className=""` |
| `Select` | `children,className="",...props` |
| `Skeleton` | `className="h-4 w-full"` |
| `Spinner` | `className=""` |
| `Tabs` | `tabs=[],active=tabs[0]?.id,onChange` |
| `Tag` | `children` |
| `Textarea` | `className="",...props` |
| `Toast` | `children` |
| `Toggle` | `checked,onChange,label` |
| `Tooltip` | `label,children` |

### Axios client and complete interceptor

This is the complete checked-in `frontend/src/config/axios.js` behavior:

```js
import axios from "axios";
import { appConfig } from "./app";

export const apiClient = axios.create({
  baseURL: appConfig.apiBaseUrl,
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
  },
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem("workflow.authToken");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let isRefreshing = false;
let failedQueue = [];

function processQueue(error, token = null) {
  failedQueue.forEach((promise) => {
    if (error) {
      promise.reject(error);
    } else {
      promise.resolve(token);
    }
  });
  failedQueue = [];
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (
      error?.response?.status === 401 &&
      !originalRequest._retry &&
      !originalRequest.url?.startsWith("/auth/") &&
      localStorage.getItem("workflow.refreshToken")
    ) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((token) => {
            originalRequest.headers.Authorization = `Bearer ${token}`;
            return apiClient(originalRequest);
          })
          .catch((err) => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const refreshToken = localStorage.getItem("workflow.refreshToken");
        const refreshResponse = await apiClient.post("/auth/refresh", { refreshToken });
        const newToken = refreshResponse.data?.data?.accessToken;
        if (newToken) {
          localStorage.setItem("workflow.authToken", newToken);
          apiClient.defaults.headers.common.Authorization = `Bearer ${newToken}`;
          originalRequest.headers.Authorization = `Bearer ${newToken}`;
          processQueue(null, newToken);
          return apiClient(originalRequest);
        }
      } catch (refreshError) {
        processQueue(refreshError, null);
        localStorage.removeItem("workflow.authToken");
        localStorage.removeItem("workflow.refreshToken");
        localStorage.removeItem("workflow.user");
        window.dispatchEvent(new CustomEvent("auth:expired"));
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);
```

If refresh returns HTTP 200 without `data.accessToken`, the code leaves the
queue unresolved and falls through to reject the original 401 only after the
condition body; this is a real edge case in the checked-in implementation.

### WebSocket client

```js
export function useWebSocket(channel = "system-health") {
  const socketRef = useRef(null);
  const [readyState, setReadyState] = useState(WebSocket.CLOSED);
  const [lastJsonMessage, setLastJsonMessage] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem("workflow.authToken");
    if (!token) return undefined;

    const base = appConfig.wsBaseUrl.replace(/\/$/, "");
    const socket = new WebSocket(`${base}/${encodeURIComponent(channel)}?token=${encodeURIComponent(token)}`);
    socketRef.current = socket;
    socket.onopen = () => setReadyState(socket.readyState);
    socket.onclose = () => setReadyState(socket.readyState);
    socket.onerror = () => setReadyState(socket.readyState);
    socket.onmessage = (event) => {
      try {
        setLastJsonMessage(JSON.parse(event.data));
      } catch {
        setLastJsonMessage(event.data);
      }
    };
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [channel]);

  const sendJsonMessage = useCallback((value) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(value));
      return true;
    }
    return false;
  }, []);

  return { readyState, sendJsonMessage, lastJsonMessage };
}
```

The backend never reads client messages; it sends a health snapshot every five
seconds. The hook has no reconnect/backoff/heartbeat and is currently unused.
Execution “live” logs instead use the unused `useLiveLog` polling hook, while
the rendered execution page performs one-time log queries.

### Test runner

- The project uses Jest 30, not Vitest.
- Script: `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand`.
- `jest.config.js` defaults to `testEnvironment: "node"`, transforms JS/JSX
  with `babel-jest`, aliases `@/`, and maps CSS to a mock.
- DOM component tests opt into `/** @jest-environment jsdom */` individually.
- Present tests cover navigation/permissions, screen modes, builder catalog,
  workflow actions, role/user forms, workflow normalization, and flow/YAML
  utilities. `src/tests/e2e` is empty.

## 4. Chat, generation, canvas, and builder end to end

### Chat/generation path

1. `ChatPage` loads session summaries with `GET /api/chat/sessions`; selecting
   one loads `GET /api/chat/sessions/:id`. Sending without a session first
   creates one.
2. `chat.service.js` posts `{content,mode?,model?,workflowId?,dry_run?}` to
   `/api/chat/sessions/:id/messages`. The backend reads content/message,
   model, mode, top-K values, candidate count, and dry-run. It does **not** read
   `workflowId`.
3. The handler stores the user message before orchestration. With durable
   storage, that mutation is synchronously snapshotted.
4. `ChatOrchestrator` retrieves tools, rules, templates, and examples from the
   semantic service. Default mode is external embedding search; lexical
   fallback runs only when explicitly configured.
5. Natural-language requests combining destructive verbs with identity/admin
   targets are blocked before generation. Retrieved tools are reconciled with
   authoritative registry definitions, filtered by role/domain/status, and
   supplemented with control tools.
6. If no executable capability remains, the response says it cannot execute;
   otherwise the synthesizer asks the configured Gemini/Ollama/
   OpenAI-compatible provider for at most five YAML candidates.
7. Every candidate is run through `RegistryValidator.ValidateCandidate`.
   Candidate selection is deterministic: highest validation score, then lower
   risk, fewer steps, lexicographically smaller candidate ID.
8. The handler stores an assistant message whose `artifacts` contain retrieval,
   candidates, selected YAML, validation summary, blocking errors, and next
   action. It returns both message objects and the same orchestration evidence.
9. `useChat` appends returned messages to React Query cache.
   `ChatArtifactPanel` displays the most recent message with artifacts.

`dry_run` is placed in `ChatRequest` but never referenced by the orchestrator.
The selected workflow is not persisted as a `Workflow` automatically, and chat
does not execute it.

### Chat-to-builder handoff

`workflowCanvas.utils.js` provides a localStorage handoff named by its utility
functions: a selected chat artifact can be stored, then
`WorkflowBuilderCanvas.getInitialCanvasState()` calls `takeWorkflowForCanvas()`.
Only an artifact with `canExecute` and YAML is converted to XYFlow nodes/edges.
This is client-side handoff, not a backend workflow record.

### Builder path

1. `WorkflowBuilderPage` passes the selected workflow ID and derives read-only
   state from `workflow:write`.
2. An existing workflow is loaded with parallel `GET /workflows/:id` and
   `GET /workflows/:id/yaml`; YAML is converted locally to nodes/edges.
3. A new builder loads `/tools/catalog`, groups registered tools, and supports
   drag/drop/connect with `@xyflow/react`.
4. Deploy topologically sorts the graph, rejects cycles locally, serializes
   YAML with `js-yaml`, then either:
   - creates using `POST /workflows`, or
   - updates YAML using `PUT /workflows/:id/yaml`,
   followed by `POST /workflows/:id/publish`.
5. Both create/YAML update and publish pass the backend full registry gate.
6. Run deploys first if necessary, posts `/workflows/:id/run`, waits for the
   synchronous response, then fetches `/executions/:id/timeline` and maps
   terminal step status back onto nodes.

The builder does not call `PUT /workflows/:id/canvas`; its authoritative save
format is YAML. The separate backend canvas endpoint can persist arbitrary
canvas state and marks semantic changes `draft-unvalidated`, but node/edge to
YAML conversion is explicitly unimplemented on the backend. `js-yaml` is
imported directly but is absent from `package.json`; the build currently finds
it only as a transitive dependency.

## 5. Execution and runner reality

### Runtime types and lifecycle

`RunWorkflow` performs object-scope checks, basic YAML validation, full registry
validation/token issuance, and optional dry-run planning. A real run:

1. Creates an `Execution` with `RUNNING` and stores it.
2. Calls `Runner.Run` synchronously in the HTTP request.
3. Runner verifies token proof, workflow content hash, and current registry
   hash, then strict-parses the exact YAML.
4. `StateManager` starts variables with `{"input": request.input}`.
5. For each YAML step it creates a `RUNNING` `ExecutionStep`, resolves nested
   templates, performs deferred/sensitive dispatch validation, resolves the
   action from the runtime tool registry, and calls the tool synchronously.
6. Success stores the tool result under `variables[step.ID]`, marks the step
   `DONE`, and appends an info log. Tool failure marks the step `FAILED`,
   appends an error log, and stops the run. A registry lookup failure stops
   before appending a failed step/log.
7. A deferred-policy violation becomes `ErrDispatchPolicyViolation`, a failed
   step, and a redacted error log.
8. Handler status becomes `DONE` on nil error, `FAILED` only for dispatch-policy
   violations, and `HEALING` for other runner errors. Healing may save validated
   repaired YAML and a report, but the execution remains `HEALING`.
9. Only after runner/healer returns does the handler store final execution,
   all logs, and all timeline entries and update workflow metrics.

### Persistence and progress

- Memory mode is the default and loses all runtime records at process exit.
- PostgreSQL mode serializes the complete `persistedState` envelope after every
  write-lock release, encrypts it with AES-256-GCM, and upserts it into the
  single `runtime_state(state_key,payload,updated_at)` row.
- The initial `RUNNING` execution is therefore durable in PostgreSQL mode, but
  per-step logs/timeline are not saved until the synchronous run ends. A crash
  can leave a `RUNNING` record with no recovery/reconciliation path.
- The HTTP request does not return until execution and healing finish.
- `/executions/:id/cancel` is 501; there is no cancellation context registry,
  worker queue, scheduler, or background job.
- The WebSocket broadcasts platform health counts only. It does not stream
  logs or steps. The UI label is “recorded”, and rendered logs are fetched.
- Status vocabulary is `PENDING`, `RUNNING`, `DONE`, `FAILED`, `HEALING`, plus
  workflow-only `draft-unvalidated`.
- `RunWorkflowRequest.mode` and `idempotencyKey` are not used. `Execution.Tokens`
  and `CostUSD` are never populated by the runner.

## 6. Error handling: five real traces

Every JSON trace below uses the exact backend envelope and the exact text
rendered by the current frontend path.

### 1. Bad login

Source: `Login` fails password verification.

```json
HTTP 401
{"success":false,"data":null,"message":"Invalid email or password","meta":null}
```

Axios rejects; `AuthContext.login` assigns the backend message to `authError`;
`LoginPage` renders exactly: **Invalid email or password**.

### 2. Public registration disabled

Source: `Register` calls `registrationForbidden`.

```json
HTTP 403
{"success":false,"data":null,"message":"Registration is not available","meta":null}
```

`AuthContext.register` assigns the message; `RegisterPage` renders exactly:
**Registration is not available**.

### 3. Expired access token and failed refresh

First protected response can be:

```json
HTTP 401
{"success":false,"data":null,"message":"Invalid or expired access token","meta":null}
```

The axios interceptor posts `/auth/refresh`. If that fails:

```json
HTTP 401
{"success":false,"data":null,"message":"Invalid or expired refresh token","meta":null}
```

The interceptor clears the three auth localStorage keys and emits
`auth:expired`; `AuthContext` clears the user. `App` then renders the login
screen text **Welcome back** and **Sign in to your Agentic Workflow account**.
There is no expiry toast.

### 4. Chat orchestration provider failure

Source: `SendChatMessage` wraps an orchestrator/provider error:

```json
HTTP 502
{"success":false,"data":null,"message":"workflow orchestration failed: <underlying error>","meta":null}
```

`useChat` retains `error.response.data.message`; `ChatWindow` renders exactly
that message in its red error block:
**workflow orchestration failed: \<underlying error\>**. The already-persisted
user message remains in the backend session; no assistant message is stored.

### 5. Run rejected after unvalidated canvas edits

Source: `runWorkflowByID` sees workflow status `draft-unvalidated`:

```json
HTTP 422
{"success":false,"data":null,"message":"Workflow canvas has unvalidated execution changes","meta":{"status":"draft-unvalidated"}}
```

`WorkflowActions` catches the request error and `apiErrorMessage` selects the
top-level backend message. The notification toast text is exactly:
**Workflow canvas has unvalidated execution changes**.

### Additional exact surfaces

- Generic resource failure heading: **Could not load this data**, followed by
  backend `message` and optional **Try again**.
- Execution run handler failures appear as notification text selected from the
  backend message. Tool failures after dispatch do not reject HTTP; the UI
  instead reports `Execution <id> finished with status HEALING` or `FAILED`.
- Canvas validation without YAML returns 422 message **Canvas node/edge to YAML
  conversion is not implemented yet. Provide yaml for validation.**

## 7. Real data structures and persistence

The following are copied from the checked-out Go source with JSON tags intact.

### Workflow

```go
type Workflow struct {
	ID               string                 `json:"id"`
	Name             string                 `json:"name"`
	Description      string                 `json:"description"`
	Owner            Principal              `json:"owner"`
	AssignedUserIDs  []string               `json:"assignedUserIds"`
	Status           string                 `json:"status"`
	Trigger          map[string]interface{} `json:"trigger"`
	Steps            int                    `json:"steps"`
	SuccessRate      float64                `json:"successRate"`
	LastRunAt        *time.Time             `json:"lastRunAt"`
	PublishedVersion int                    `json:"publishedVersion"`
	DraftVersion     int                    `json:"draftVersion"`
	Tags             []string               `json:"tags"`
	YAML             string                 `json:"-"`
	Canvas           WorkflowCanvas         `json:"-"`
	CreatedAt        time.Time              `json:"createdAt"`
	UpdatedAt        time.Time              `json:"updatedAt"`
	Archived         bool                   `json:"-"`
}
```

`YAML`, `Canvas`, and `Archived` are hidden from ordinary JSON responses but
are explicitly restored into the durable `storedWorkflow` wrapper:

```go
type storedWorkflow struct {
	models.Workflow
	YAML     string                `json:"yaml"`
	Canvas   models.WorkflowCanvas `json:"canvas"`
	Archived bool                  `json:"archived"`
}
```

### Execution and ExecutionStep

```go
type Execution struct {
	ID           string     `json:"id"`
	WorkflowID   string     `json:"workflowId"`
	WorkflowName string     `json:"workflowName"`
	Status       string     `json:"status"`
	StartedAt    time.Time  `json:"startedAt"`
	CompletedAt  *time.Time `json:"completedAt"`
	DurationMS   int64      `json:"durationMs"`
	Tokens       Tokens     `json:"tokens"`
	CostUSD      float64    `json:"costUsd"`
	StartedBy    Principal  `json:"startedBy"`
}

type ExecutionStep struct {
	ID          string     `json:"id"`
	NodeID      string     `json:"nodeId"`
	Label       string     `json:"label"`
	Status      string     `json:"status"`
	StartedAt   time.Time  `json:"startedAt"`
	CompletedAt *time.Time `json:"completedAt"`
	DurationMS  *int64     `json:"durationMs"`
}
```

`Executions`, `ExecutionLogs`, and `Timelines` are independent maps inside the
persisted envelope, keyed by execution ID.

### User, Role, and Permission

```go
type User struct {
	ID                  string     `json:"id"`
	Name                string     `json:"name"`
	Email               string     `json:"email"`
	RoleID              string     `json:"roleId"`
	PermissionOverrides []string   `json:"permissionOverrides"`
	Status              string     `json:"status"`
	Initials            string     `json:"initials"`
	Timezone            string     `json:"timezone,omitempty"`
	LastLoginAt         *time.Time `json:"lastLoginAt"`
	CreatedAt           time.Time  `json:"createdAt"`
	TwoFactorEnabled    bool       `json:"twoFactorEnabled,omitempty"`
	EmailVerified       bool       `json:"emailVerified,omitempty"`

	Role        RoleRef  `json:"-"`
	Permissions []string `json:"-"`
}

type Role struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Permissions []string  `json:"permissions"`
	CreatedAt   time.Time `json:"createdAt"`
}

type Permission struct {
	Key         string `json:"key"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Group       string `json:"group"`
}
```

`Role` and effective `Permissions` are request-time snapshots and are excluded
from durable users. The persisted wrapper accepts legacy copied fields only as
migration inputs:

```go
type storedUser struct {
	models.User
	LegacyRole        *models.RoleRef `json:"role,omitempty"`
	LegacyPermissions []string        `json:"permissions,omitempty"`
}
```

At request time, `EffectiveUserLocked` derives the role live from `RoleID` and
forms the deterministic union of current role permissions plus additive user
overrides. No permission-result cache exists.

### Registry Tool and Rule

```go
type Tool struct {
	ToolID                    string                 `json:"tool_id"`
	Name                      string                 `json:"name"`
	DisplayName               string                 `json:"display_name"`
	ERPSystem                 string                 `json:"erp_system,omitempty"`
	Module                    string                 `json:"module"`
	Status                    string                 `json:"status"`
	Description               string                 `json:"description"`
	BusinessCapability        string                 `json:"business_capability"`
	BPIProcessAlignment       []string               `json:"bpi_process_alignment"`
	Endpoint                  string                 `json:"endpoint"`
	HTTPMethod                string                 `json:"http_method"`
	MCPToolName               string                 `json:"mcp_tool_name"`
	InputSchema               map[string]interface{} `json:"input_schema"`
	RequiredParameters        []string               `json:"required_parameters"`
	OptionalParameters        []string               `json:"optional_parameters"`
	AllowedRoles              []string               `json:"allowed_roles"`
	RiskLevel                 string                 `json:"risk_level"`
	IsReadOnly                bool                   `json:"is_read_only"`
	SideEffects               []string               `json:"side_effects"`
	Preconditions             []string               `json:"preconditions"`
	Postconditions            []string               `json:"postconditions"`
	FailureModes              []string               `json:"failure_modes"`
	ValidatorChecks           []string               `json:"validator_checks"`
	PromptUsageGuidance       string                 `json:"prompt_usage_guidance"`
	SemanticSearchKeywords    []string               `json:"semantic_search_keywords"`
	SemanticSearchDescription string                 `json:"semantic_search_description"`
	ExecutionNotes            string                 `json:"execution_notes"`
	CurrentGaps               []string               `json:"current_gaps"`
	SourceFile                string                 `json:"source_file,omitempty"`
}

type RuleCondition struct {
	Type      string      `json:"type"`
	Parameter string      `json:"parameter"`
	Operator  string      `json:"operator"`
	Value     interface{} `json:"value"`
}

type Rule struct {
	RuleID               string        `json:"rule_id"`
	RuleName             string        `json:"rule_name"`
	RuleType             string        `json:"rule_type"`
	ERPSystem            string        `json:"erp_system,omitempty"`
	Domain               string        `json:"domain"`
	Description          string        `json:"description"`
	AppliesToTools       []string      `json:"applies_to_tools"`
	AppliesToRoles       []string      `json:"applies_to_roles"`
	Condition            RuleCondition `json:"condition"`
	EnforcementAction    string        `json:"enforcement_action"`
	Severity             string        `json:"severity"`
	ValidatorMessage     string        `json:"validator_message"`
	LLMPromptInstruction string        `json:"llm_prompt_instruction"`
	HealingGuidance      string        `json:"healing_guidance"`
	BPIAlignment         []string      `json:"bpi_alignment"`
	AuditFieldsRequired  []string      `json:"audit_fields_required"`
	Enabled              bool          `json:"enabled"`
	SourceFile           string        `json:"source_file,omitempty"`
}
```

### ValidationToken and DeferredCheck

```go
type ValidationToken struct {
	WorkflowContentHash string          `json:"workflow_content_hash"`
	RegistryHash        string          `json:"registry_hash"`
	PassedAt            time.Time       `json:"passed_at"`
	DeferredChecks      []DeferredCheck `json:"deferred_checks"`
	Proof               string          `json:"-"`
}

type DeferredCheck struct {
	StepIndex int      `json:"step_index"`
	ParamKey  string   `json:"param_key"`
	RuleIDs   []string `json:"rule_ids"`
}
```

Tokens are transient, signed with a per-process random HMAC key, and are not in
`persistedState`. A restart invalidates every prior proof, but handlers issue a
fresh token immediately before synchronous execution.

### AuditEntry reality

There is no type named `AuditEntry` anywhere in backend or frontend source.
The real audit record is `AuditLog`:

```go
type AuditLog struct {
	ID        string                 `json:"id"`
	Actor     Principal              `json:"actor"`
	Action    string                 `json:"action"`
	Resource  ResourceRef            `json:"resource"`
	IPAddress string                 `json:"ipAddress"`
	UserAgent string                 `json:"userAgent"`
	Before    map[string]interface{} `json:"before"`
	After     map[string]interface{} `json:"after"`
	CreatedAt time.Time              `json:"createdAt"`
}
```

It is persisted in `AuditLogs map[string]*models.AuditLog`. The store's `Audit`
helper expects callers to hold the store write lock when the business mutation
and audit record must be atomic.

### ProviderConfig

```go
type ProviderConfig struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Type      string    `json:"type"`
	BaseURL   string    `json:"baseUrl,omitempty"`
	Model     string    `json:"model"`
	APIKey    string    `json:"-"`
	Active    bool      `json:"active"`
	CreatedAt time.Time `json:"createdAt"`
}
```

`APIKey` is hidden from ordinary JSON and stored in the encrypted wrapper:

```go
type storedProvider struct {
	models.ProviderConfig
	APIKey string `json:"apiKey"`
}
```

Provider handlers return `providerConfigView`, which exposes a four-character
`keyPreview`, never the key.

### Complete persistence envelope

```go
type persistedState struct {
	Version                 int                                       `json:"version"`
	Counter                 uint64                                    `json:"counter"`
	Users                   map[string]*storedUser                    `json:"users"`
	PasswordHashes          map[string]string                         `json:"passwordHashes"`
	RefreshSessions         map[string]RefreshSession                 `json:"refreshSessions"`
	Roles                   map[string]*models.Role                   `json:"roles"`
	Permissions             []models.Permission                       `json:"permissions"`
	Workflows               map[string]*storedWorkflow                `json:"workflows"`
	Versions                map[string][]models.WorkflowVersion       `json:"versions"`
	Templates               map[string]*models.WorkflowTemplate       `json:"templates"`
	Executions              map[string]*models.Execution              `json:"executions"`
	ExecutionLogs           map[string][]models.ExecutionLog          `json:"executionLogs"`
	Timelines               map[string][]models.ExecutionStep         `json:"timelines"`
	Healing                 map[string]models.HealingReport           `json:"healing"`
	Chats                   map[string]*models.ChatSessionDetail      `json:"chats"`
	Settings                models.SettingsBundle                     `json:"settings"`
	Providers               map[string]*storedProvider                `json:"providers"`
	Integrations            map[string]*models.Integration            `json:"integrations"`
	Webhooks                map[string]*models.Webhook                `json:"webhooks"`
	AuditLogs               map[string]*models.AuditLog               `json:"auditLogs"`
	Notifications           map[string]*models.Notification           `json:"notifications"`
	NotificationPreferences map[string]models.NotificationPreferences `json:"notificationPreferences"`
	APIKeys                 map[string]*storedAPIKey                  `json:"apiKeys"`
	Uploads                 map[string]*models.UploadedFile           `json:"uploads"`
	UploadContents          map[string][]byte                         `json:"uploadContents"`
}
```

The whole JSON envelope is encrypted and stored as one PostgreSQL `BYTEA`;
there are no normalized workflow/execution/user tables. A single advisory
writer lock prevents two backend writers from owning the same state key.

## 8. Registry and validation reality

### Evaluated registry source and current fingerprint

Default startup paths are:

```go
getEnv("TOOL_REGISTRY_PATH", "./configs/registries/all_tools_master_registry.json")
getEnv("RULE_REGISTRY_PATH", "./configs/registries/all_rules_master_registry.json")
```

Because both resolved paths are non-empty, `cmd/server/main.go` calls
`LoadBundle`; the broader `dataset/` loader is only the fallback when either
path string is empty.

Current master files contain 17 tools (all
`active_mcp_schema_present`) and 11 enabled rules.

| Artifact | Full file SHA-256 | Loader version |
|---|---|---|
| tools master | `ddde364d42ba7ae98ca95fa4ac1520077b851ce196d75b158ae755d403790a1f` | `sha256:ddde364d42ba7ae9` |
| rules master | `c1bc1f5ddd4f342e26ff0dae5133358bb660205f8cdd15ecc636b3cf26dcef39` | `sha256:c1bc1f5ddd4f342e` |

`RegistryValidator.RegistryHash()` hashes
`toolsVersion + "\x00" + rulesVersion`. For these files it is:

```text
sha256:cce9d87016747dcf6d04740590c8e1e31a45ab9e68741caeda378e61b436cc3e
```

Workflow content hash is SHA-256 of the exact raw YAML string. A successful
token binds that content hash, registry hash, UTC pass time, and cloned deferred
checks to a process-local HMAC-SHA-256 proof.

### Implemented validation behavior

Before rule-type dispatch, validation always performs strict YAML/schema
validation, tool lookup, tool status, required tool parameters, tool
`allowed_roles`, credential-like key detection, and deferred checks for
unresolved templates.

| Rule type | Plan-time behavior | Resolved dispatch evaluator |
|---|---|---|
| `rbac` | Blocks applicable tools when role matches and action is `block`. | none; no deferred RBAC values are created. |
| `parameter_required` | Checks listed parameter names; unresolved templates are deferred. | Requires a present, non-empty, resolved value. |
| `amount_threshold` | Numeric compare; unresolved parameter is deferred; supports approval/block. | Numeric compare and approval/block. |
| `quantity_threshold` | Same as amount threshold. | Same. |
| `process_order` | Ensures first named action occurs before the second. | none. |
| `separation_of_duties` | Compares literal `requester_id` and `approver_id` in each step. | none; templated identities are not deferred by this evaluator. |
| `risk_escalation` | High-risk used tool requires an approval-like action. | none. |
| `audit` | Write/high-risk used tool requires exact `audit.write_audit_log`. | none. |
| `data_confidentiality` | Dedicated sensitive-key checks plus unresolved sensitivity deferral. | Scans resolved nested parameters for sensitive keys. |
| `execution_safety` | No generic switch evaluator; tool existence/status are enforced by dedicated checks. | none. |
| `capability_gap` | No generic switch evaluator; tool status is enforced by dedicated checks. | none. |
| `cache_safety` | Explicitly accepted as dedicated/prompt-grounded, but there is no dedicated evaluator in this file. | none. |
| any other type | Adds warning `Unsupported governance rule type <type> for rule <id>`; it does not fail solely for being unsupported. | A deferred instance fails closed with `deferred rule has no evaluator`. |

Numeric operators actually implemented are `>`, `>=`, `<`, `<=`, `==`, and
`!=`. Other operator strings in the current master are consumed by
type-specific evaluators rather than a generic operator engine:
`exists`, `not_exists`, and `before`. The master rule types/operators are:

| Rule | Type | Condition/operator | Enforcement |
|---|---|---|---|
| `GLOBAL-SAFETY-001` | `execution_safety` | `tool_validity / exists` | `block` |
| `GLOBAL-SAFETY-002` | `data_confidentiality` | `sensitive_key / not_exists` | `block` |
| `GLOBAL-SAFETY-003` | `risk_escalation` | `risk_level / >=` | `require_human_approval` |
| `GLOBAL-AUDIT-001` | `audit` | `audit_required / ==` | `write_audit_log` |
| `PROC-PARAM-001` | `parameter_required` | `parameter_required / exists` | `block` |
| `PROC-THRESH-001` | `quantity_threshold` | `quantity_threshold / >` | `require_human_approval` |
| `PROC-POLICY-001` | `process_order` | `tool_order / before` | `block` |
| `FIN-RBAC-001` | `rbac` | `role_permission / ==` | `block` |
| `FIN-PROC-001` | `process_order` | `tool_order / before` | `block` |
| `FIN-PROC-002` | `process_order` | `tool_order / before` | `block` |
| `CAP-GAP-001` | `capability_gap` | `tool_status / !=` | `require_schema_generation` |

### Mutation paths

Only four registry-write endpoints exist:

- `POST /api/registry/tools -> Manager.AddTool`
- `PUT /api/registry/tools/:id -> Manager.UpdateTool`
- `POST /api/registry/rules -> Manager.AddRule`
- `PUT /api/registry/rules/:id -> Manager.UpdateRule`

The route permission is `registry:write`, then the handler independently rejects
System Admins and any user without that effective permission. Requests use
`DisallowUnknownFields`, require exactly one JSON object, enforce required
strings, and clear `SourceFile`.

Under the manager mutex, mutation clones the current registry, validates
identity/uniqueness, writes indented JSON to a same-directory temporary file,
flushes and closes it, replaces the master file, then calls `ReplaceAll` on the
live tool/rule registry. The response contains old/new hashes and
`semanticRebuildSuggested:true`. Tool upsert also registers a generic runtime
MCP tool if absent. Semantic search is **not** rebuilt automatically.

There are no delete endpoints. The mutex is process-local; the file operation
has no cross-process lock or compare-and-swap against external writers.

### Seed and separation-of-duties reality

Seed preview is opt-in and off by default:

```go
SeedSampleData: getEnvBool("SEED_SAMPLE_DATA", false),
```

```go
if cfg.SeedSampleData {
	preview, seedErr := handler.RegistryManager.LoadSeedPreview(
		cfg.SampleToolSeedPath,
		cfg.SampleRuleSeedPath,
	)
	// log preview only
}
```

`LoadSeedPreview` strictly decodes and validates seed definitions, returns them
inside `SeedPreview`, and does not publish, persist, or register them. The live
hash returned in the preview is the pre-existing evaluated hash.

The default evaluated rules master in `configs/registries` contains no
`separation_of_duties` rule. A sample rule exists in
`configs/seed/sample_rules.json`. Contrary to a narrower “only in seed”
description, additional separation-of-duties rules also exist in the broader
`dataset/02_governance_rules` files and their aggregate master. They do not
reach the default evaluated registry because startup uses the explicit
`configs/registries` paths. The evaluator code nevertheless implements the
rule type.

`TestSeedNotLoadedIntoEvaluatedRegistry` and related seed tests verify that
preview loading leaves registry counts/hash unchanged and that strict failures
also leave the live registries unchanged.

## 9. Exhaustive repository-visible gap list

“Gap” here means absent, stubbed, in-memory-only, hard-coded, unused, or named
more strongly than its implementation. This list is based on static source,
the full backend test run, and the production frontend build.

### Authentication and account lifecycle

- Password recovery, password reset, email verification, OAuth, 2FA,
  security-preference changes, and email invitations are explicit HTTP 501
  stubs.
- Page files exist for reset, verify, OAuth callback, and 2FA, but `AuthRouter`
  cannot navigate to them.
- Auth rate limiting is process-local fixed-window state, keyed by IP/path. It
  is not shared across replicas and cleans expired keys only every 1,024 calls.
- JWT validation checks HS256 signature, expiry, and string subject. It has no
  issuer, audience, JWT ID/revocation list, or key rotation mechanism.
- Refresh sessions are server-side and suspension revokes them. Existing access
  JWTs are not individually revoked, but every protected request re-derives the
  user and rejects a suspended account.
- Development defaults public registration on; production validation forces it
  off. Registration always assigns `role_client`.
- Generated “API keys” are storage records only. No middleware authenticates
  them, scopes are not enforced, and records have no owner ID. List/delete
  operate on the global collection.

### RBAC and administrative boundaries

The four hard-coded built-in role definitions are:

| Identifier | Exact permission slice |
|---|---|
| `role_admin` (`RolePlatformAdminID`) | `workflow:read`, `workflow:write`, `workflow:run`, `chat:use`, `workflow:read_own`, `workflow:run_own`, `execution:read_own`, `settings:manage`, `provider:manage`, `registry:read`, `registry:write`, `user:manage`, `audit:read` |
| `role_system_admin` (`RoleSystemAdminID`) | `user:manage`, `registry:read`, `audit:read` |
| `role_builder` (`RoleBuilderID`) | `workflow:read`, `workflow:write`, `workflow:run`, `chat:use`, `registry:read` |
| `role_client` (`RoleClientID`) | `chat:use`, `workflow:read_own`, `workflow:run_own`, `execution:read_own` |

- Permission definitions and the four roles are compiled into `NewStore`.
  Existing persisted role permission slices remain authoritative, including an
  explicitly empty slice; missing built-in role records are re-added.
- Platform Admin has all 13 currently defined permissions. Its hard floor is
  only `provider:manage`, `registry:write`, `user:manage`, and
  `settings:manage`; other permissions can be removed.
- System Admin cannot pass provider route middleware because it lacks
  `provider:manage`; provider handlers also require the live
  `RolePlatformAdminID`. Provider responses never expose `APIKey`.
- System Admin lacks `registry:write`; registry mutation handlers additionally
  reject `RoleSystemAdminID`, so the boundary is not UI-only.
- Last-active-Platform-Admin checks derive role and active status live for role
  change, status change, legacy suspend, and delete paths. Only Platform Admin
  can suspend/demote Platform Admin. These are handler checks, not generic RBAC
  middleware.
- `canManageRoles` recognizes only Platform/System built-in role IDs. A custom
  role with `user:manage` can enter user endpoints but cannot create/update/
  delete roles.
- Workflow write permission is global: write handlers do not enforce owner or
  assignment scope. Own-scope rules exist only for workflow read/run and
  execution read.
- Admins with global workflow read/write can access every chat session; clients
  are owner-scoped.
- Audit reads are global and audit records have no tenant/organization field.
- The model/request accepts additive `PermissionOverrides`, but no current HTTP
  endpoint changes them.

### Multi-user and resource ownership

- There is no tenant/organization model. `organizationName` from registration
  is accepted in the request struct but never stored.
- Notifications have no owner field. List/read/delete/read-all act on the
  global map; `read-all` marks every notification. No production code creates a
  notification, so the list stays empty unless state was externally restored
  or a test populated it.
- Uploads have no owner and are readable by anyone with global `workflow:read`.
  Upload accepts the entire file into memory with no size, MIME, extension, or
  malware restriction.
- API keys, integrations, webhooks, settings, providers, roles, permissions,
  and audit are platform-global.
- User deletion does not clean workflow assignments, workflow ownership,
  executions, audit references, chat sessions, or notifications.
- Workflow deletion does not cascade versions, executions, logs, timelines, or
  healing reports.

### Workflow model and builder semantics

- Trigger data is stored and validated but the runner does not schedule or
  dispatch triggers. Execution starts only through the run endpoint.
- Runner executes YAML steps strictly in list order. It ignores
  `WorkflowStepBlueprint.Condition`, `OnError`, and `RetryCount`; “condition”,
  “on error”, and “retry” are schema/prompt fields, not runtime control flow.
- The XYFlow graph is topologically flattened into a linear YAML step list.
  Edge types/labels and branching semantics are not encoded in builder YAML.
- Backend canvas node/edge-to-YAML conversion is explicitly unimplemented.
  Canvas and YAML can diverge; semantic canvas writes only mark the record
  `draft-unvalidated`.
- The current builder saves YAML and never calls the canvas write endpoint.
- Template creation performs no YAML validation. Validation happens only when
  a template is used.
- Duplicate workflow performs a shallow struct copy and no revalidation.
- Archive sets workflow status to `DONE`, conflating workflow archive state
  with the execution terminal status vocabulary.
- List workflows can still return archived records; “active” filtering is a
  frontend derived view.
- `CreateWorkflowRequest.OwnerID` is ignored; owner is always the caller.
- Self-healing replaces only `workflow.YAML`. It does not update step count,
  canvas, draft version, or `UpdatedAt`, so a repaired record can have stale
  derived metadata.
- Publish stores a version but has no optimistic version number supplied by the
  client. Content-hash checks protect only the validation/publish critical
  section.

### Chat and generation

- Chat user messages are committed before retrieval/generation. Provider
  failure leaves the user message with no assistant response.
- Posting to a nonexistent session ID creates a session with that caller-
  supplied path ID; there is no separate not-found requirement on send.
- Chat `workflowId` sent by the frontend is ignored.
- Chat `dry_run` is parsed into `ChatRequest` but never changes orchestrator
  behavior.
- Chat does not persist selected YAML as a workflow and does not execute it.
  Handoff to the builder uses browser localStorage.
- Candidate generation is one provider response parsed into at most five
  candidates. There is no token streaming or incremental UI response.
- The fallback `Synthesize` endpoint uses only the basic YAML validator after
  generation; it does not run the full registry gate until a later validation,
  create, publish, or run action.
- Provider generation usage is attached to candidate metadata, but not rolled
  into execution token/cost records.

### Runner, execution, and analytics

- Execution is synchronous inside the HTTP request; there is no queue, worker,
  lease, scheduler, timeout controller, or cancellation registry.
- Cancellation is a 501 stub.
- `RunWorkflowRequest.Mode` and `IdempotencyKey` are unused, so retries can
  dispatch side effects again.
- Step state/log/timeline is accumulated in memory and persisted only after the
  run returns. There is no actual live-log stream.
- A runtime tool lookup failure has no failed timeline entry/log because it
  returns before that append path.
- Ordinary tool errors set the execution to `HEALING`, even if repair fails;
  only a deferred dispatch-policy violation becomes `FAILED`.
- A successful repair does not resume/retry the failed execution, and execution
  status remains `HEALING`.
- Run HTTP response is 200 with message `Execution completed` for DONE, FAILED,
  and HEALING terminal outcomes.
- A process crash can leave a durable execution `RUNNING`; no startup recovery
  marks it failed or resumes it.
- `Tokens` and `CostUSD` remain zero in runner-created executions.
- Success-rate aggregates count only `DONE` and `FAILED`; `HEALING` outcomes
  are excluded from the denominator.
- Analytics F1 is explicitly unavailable and always returns null metrics.
- Analytics intervals are hard-coded to seven days (heatmap 14); most endpoints
  do not honor a range parameter.

### Registry, validation, and semantic search

- Registry version strings use only the first 16 hexadecimal characters of
  each master file SHA-256. The combined registry hash therefore binds two
  truncated version fingerprints, not both full file digests.
- Registry manager locking is process-local. PostgreSQL's runtime-state writer
  lock does not protect JSON master files.
- `RuleRegistry.GetEnabledRules` iterates the rule slice without taking its
  `RWMutex`; concurrent `ReplaceAll` publication therefore has a data-race
  exposure even though the swap itself holds the write lock.
- `Manager.Hash` reads tool and rule versions under two separate registry locks
  and does not take the manager mutation mutex, so a concurrent write can
  produce a transient mixed-version combined hash.
- Registry has create/update but no delete endpoints.
- Registry writes mutate checked-in-style JSON files at runtime; container
  read-only filesystems or multiple replicas are not coordinated.
- Semantic index rebuild is suggested in the mutation result/UI but is manual.
  Search may remain stale after a write.
- Tool additions register a runtime generic MCP action. Tool updates do not
  replace an already registered concrete/generic tool implementation.
- New rule schemas accept any non-empty `rule_type`, condition type/operator,
  and enforcement action. Unsupported rule types produce a warning rather than
  a validation failure.
- The Registry UI's default new rule uses `rule_type:"policy"`, which has no
  evaluator and will be accepted by strict schema validation but only produce
  an unsupported-type warning.
- The separation-of-duties evaluator compares literal requester/approver
  values; it does not create deferred checks for templated identities.
- `cache_safety` is listed as dedicated/prompt-grounded in the switch but no
  cache-safety evaluator exists in the validator.
- External semantic search is the default, yet its service is separately
  deployed/configured. Lexical fallback is off unless opted in.
- `MCP_MODE=remote` is default. If no base URL exists, execution refuses rather
  than simulating. Mock mode is explicit, supports only `demo.echo`, and is
  prohibited in production.
- Many master actions resolve to `GenericMCPTool`; executable registry status
  establishes schema/governance eligibility, not proof that a remote MCP server
  implements the action.

### Persistence and deployment

- `STORAGE_DRIVER=memory` is the default. Production config validation requires
  PostgreSQL, but non-production environments silently use ephemeral state.
- PostgreSQL persistence is one encrypted whole-state blob, rewritten
  synchronously after every write unlock. Cost grows with all stored uploads,
  chats, logs, and records.
- One advisory writer lock intentionally prevents horizontal active-active
  backend writers for the same state key.
- There is one state schema version and one blob table; record-level SQL
  querying, indexes, foreign keys, partial updates, and database-enforced
  referential integrity do not exist.
- Upload contents are embedded in that whole encrypted snapshot.
- Settings patches persist arbitrary maps but do not reconfigure the live
  server, CORS, registration, JWT, semantic client, MCP client, or environment
  fallback synthesizer. Startup writes selected environment values back into
  settings, so some edited keys can be overwritten on restart.
- Webhooks are only CRUD plus an explicit test delivery. No workflow/execution
  event publisher invokes stored webhooks.
- Integrations are records plus endpoint probes/status. Runner tools do not
  resolve or use stored integrations.
- Outbound webhook/integration/provider URL checks require credential-free
  HTTP(S) and disable redirect following, but do not block loopback, link-local,
  or private-network destinations.
- Settings, webhook, integration, API-key, notification, and most workflow
  delete/archive changes do not create audit records.

### Frontend completeness and naming

- The app is not URL-routed despite installed `react-router-dom`; browser back,
  refresh deep links, shareable URLs, and route parameters do not exist.
- All page modules are eager imports. The build is one JavaScript chunk.
- `reactflow` and `@xyflow/react` are both installed; current builder uses
  `@xyflow/react`, while older components/mocks retain the parallel surface.
- `js-yaml` is a direct source import but is not a direct dependency.
- `config/queryClient.js`, `config/router.js`, the five small feature Zustand
  stores, `CanvasContext`, `useWorkflowBuilder`, `useWebSocket`, and
  `useLiveLog` have no runtime import sites found by `rg`.
- Multiple page files are aliases or unused because the state map points
  several navigation entries to one aggregate page.
- “Live Logs” renders recorded logs and does not poll or subscribe.
- Execution detail is an alias of the logs page.
- User administration can create users, assign roles, suspend/reactivate, edit
  role permissions, create roles, and delete custom roles. It has no UI action
  for user delete, user rename, invite, or legacy activate/suspend endpoints, so
  it is not full user CRUD.
- System Admin role editing hides permissions it does not hold. Saving an
  existing role that has such permissions is rejected by the backend removal
  guard; the UI cannot display/preserve those hidden values in that editor.
- Settings UI creates webhooks but does not edit/delete/test them. Integrations
  are display-only with a disabled button. API keys are display-only there.
- Provider UI has create/update/activate/test but no delete API exists.
- Frontend permission checks are presentation only; they correctly coexist
  with backend enforcement, but stored local user data can briefly be stale
  until `/auth/me` or `refreshUser`.
- No ErrorBoundary wraps `App` even though an ErrorBoundary component exists.
- No E2E tests exist; frontend tests were not part of the requested
  verification command.

## 10. Build and verification reality

### Backend test run

Command run from `backend`:

```text
go test ./... -count=1
```

Final output:

```text
?   	github.com/sanjeewa/agentic-orchestrator/cmd/generate-eval-dataset	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/cmd/run-experiment	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/cmd/server	[no test files]
ok  	github.com/sanjeewa/agentic-orchestrator/dataset/eval	1.659s
ok  	github.com/sanjeewa/agentic-orchestrator/internal/api/handlers	3.997s
ok  	github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares	2.085s
ok  	github.com/sanjeewa/agentic-orchestrator/internal/api/routes	3.004s
?   	github.com/sanjeewa/agentic-orchestrator/internal/authn	[no test files]
ok  	github.com/sanjeewa/agentic-orchestrator/internal/config	0.678s
?   	github.com/sanjeewa/agentic-orchestrator/internal/core/healing	[no test files]
ok  	github.com/sanjeewa/agentic-orchestrator/internal/core/orchestrator	1.546s
ok  	github.com/sanjeewa/agentic-orchestrator/internal/core/registry	0.891s
?   	github.com/sanjeewa/agentic-orchestrator/internal/core/runner	[no test files]
ok  	github.com/sanjeewa/agentic-orchestrator/internal/core/semanticsearch	2.503s
ok  	github.com/sanjeewa/agentic-orchestrator/internal/core/synthesizer	2.524s
?   	github.com/sanjeewa/agentic-orchestrator/internal/core/validator	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/internal/models	[no test files]
ok  	github.com/sanjeewa/agentic-orchestrator/internal/repository	1.540s
ok  	github.com/sanjeewa/agentic-orchestrator/internal/storage	2.341s
ok  	github.com/sanjeewa/agentic-orchestrator/internal/tools	2.406s
?   	github.com/sanjeewa/agentic-orchestrator/internal/tools/impl	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/pkg/logger	[no test files]
?   	github.com/sanjeewa/agentic-orchestrator/pkg/parser	[no test files]
ok  	github.com/sanjeewa/agentic-orchestrator/tests/integration	3.746s
?   	github.com/sanjeewa/agentic-orchestrator/tests/mocks	[no test files]
ok  	github.com/sanjeewa/agentic-orchestrator/tests/unit	90.135s
```

Exit code: 0.

### Frontend production build

Command run from `frontend`:

```text
npm run build
```

Output:

```text
> agentic-workflow-frontend@0.1.0 build
> vite build

vite v7.3.6 building client environment for production...
transforming...
✓ 2145 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   0.57 kB │ gzip:   0.34 kB
dist/assets/index-KyR6d75n.css   73.23 kB │ gzip:  12.74 kB
dist/assets/index-CmiFTgpc.js   692.29 kB │ gzip: 214.61 kB

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
✓ built in 7.84s
```

Exit code: 0. There are no lazy route imports and only one emitted JavaScript
chunk.

### Largest direct installed dependency directories

`npm ls rollup-plugin-visualizer --depth=0` returned `(empty)`, so no bundle
visualizer is available. The requested fallback is recursive installed size of
the direct dependency directories; these are **not** per-package contributions
to the minified bundle:

| Rank | Direct dependency | Installed bytes | MiB |
|---:|---|---:|---:|
| 1 | `lucide-react` | 30,003,915 | 28.61 |
| 2 | `react-dom` | 7,319,413 | 6.98 |
| 3 | `recharts` | 6,756,347 | 6.44 |
| 4 | `axios` | 1,833,197 | 1.75 |
| 5 | `@xyflow/react` | 1,517,317 | 1.45 |
| 6 | `react-hook-form` | 1,290,192 | 1.23 |
| 7 | `@tanstack/react-query` | 858,883 | 0.82 |
| 8 | `@iconify/react` | 210,588 | 0.20 |
| 9 | `reactflow` | 183,931 | 0.18 |
| 10 | `react` | 171,604 | 0.16 |

### `package.json` dependencies verbatim

```json
"dependencies": {
  "@iconify/react": "^6.0.2",
  "@tanstack/react-query": "^5.90.8",
  "@xyflow/react": "^12.10.2",
  "axios": "^1.13.2",
  "lucide-react": "^1.14.0",
  "react": "^19.2.0",
  "react-dom": "^19.2.0",
  "react-hook-form": "^7.66.1",
  "react-router-dom": "^7.9.5",
  "reactflow": "^11.11.4",
  "recharts": "^3.3.0",
  "zustand": "^5.0.8"
},
"devDependencies": {
  "@babel/core": "^7.28.5",
  "@babel/preset-react": "^7.28.5",
  "@eslint/js": "^9.39.1",
  "@testing-library/jest-dom": "^6.9.1",
  "@testing-library/react": "^16.3.0",
  "@types/react": "^19.2.5",
  "@types/react-dom": "^19.2.3",
  "@vitejs/plugin-react": "^5.1.1",
  "autoprefixer": "^10.4.22",
  "babel-jest": "^30.2.0",
  "eslint": "^9.39.1",
  "eslint-plugin-react-hooks": "^7.0.1",
  "eslint-plugin-react-refresh": "^0.4.24",
  "globals": "^16.5.0",
  "jest": "^30.2.0",
  "jest-environment-jsdom": "^30.2.0",
  "postcss": "^8.5.6",
  "prettier": "^3.6.2",
  "tailwindcss": "^3.4.18",
  "vite": "^7.2.4"
}
```

### Worktree verification

The only file created by this reconnaissance is
`docs/ARCHITECTURE_MAP.md`. The pre-existing untracked `.claude/` directory was
not read or modified. No frozen path was edited. `frontend/dist` is ignored and
does not appear in Git status.
