# Frontend Portal and RBAC Gap Assessment

> **Historical pre-implementation assessment.** Portal slices S1-S5 were implemented after this plan. Use `CURRENT_STATE.md` and `docs/PORTAL_RESULT.md` for the current behavior; the gap statements below are retained as planning evidence.

Assessment date: 2026-07-20  
Scope: pre-implementation audit only; no portal features were built.  
Status vocabulary: **EXISTS** means the required behavior is present on the inspected path; **PARTIAL** means useful code exists but the stated portal requirement is not end-to-end; **MISSING** means it was not found in the named search locations.

## Executive verdict

Approximately **45% of the requested portal capability is reusable by feature count**. Authentication, live user identity, backend permission middleware, user/role APIs, operational screens, catalog reads, integrations/webhooks/API-key APIs, and semantic status/rebuild already exist. This is not 45% production readiness: all mutable application state is process-local, the frontend has no real role gate, clients are not restricted to their own resources, and the three hardest admin requirements (registry mutation, active model-provider configuration, and semantic configuration) are not runtime-config ready.

The biggest backend gap is a durable, audited runtime-configuration layer that can atomically replace tool/rule snapshots and rewire every consumer safely. The second is tenant/owner authorization for workflows, executions, logs, and chat sessions. Building admin forms before those APIs would create dead or misleading controls.

No actual secret value is reproduced in this report. Any future provider credential must be rendered as `[REDACTED]` or a non-reversible preview.

## Already done (do not rebuild)

- Login and registration are real frontend flows calling `/auth/login` and `/auth/register` (`frontend/src/pages/auth/LoginPage.jsx:25`, `frontend/src/pages/auth/LoginPage.jsx:31`, `frontend/src/pages/auth/RegisterPage.jsx:25`, `frontend/src/pages/auth/RegisterPage.jsx:34`, `frontend/src/services/auth.service.js:17`, `frontend/src/services/auth.service.js:22`).
- The backend uses bcrypt for login/registration and returns a session user (`backend/internal/api/handlers/auth_handler.go:17`, `backend/internal/api/handlers/auth_handler.go:43`, `backend/internal/api/handlers/auth_handler.go:72`, `backend/internal/api/handlers/auth_handler.go:83`, `backend/internal/api/handlers/auth_handler.go:127`). Refresh sessions are server-side and rotated (`backend/internal/api/handlers/auth_handler.go:144`, `backend/internal/api/handlers/auth_handler.go:157`, `backend/internal/api/handlers/auth_handler.go:172`).
- `/auth/me` returns the current role, role ID, and permissions (`backend/internal/api/handlers/auth_handler.go:178`, `backend/internal/api/handlers/handler.go:120`, `backend/internal/api/handlers/handler.go:124`, `backend/internal/api/handlers/handler.go:126`). The frontend stores that user in `AuthContext` and refreshes it from `/auth/me` (`frontend/src/context/AuthContext.jsx:15`, `frontend/src/context/AuthContext.jsx:20`, `frontend/src/context/AuthContext.jsx:29`, `frontend/src/context/AuthContext.jsx:101`). Reuse this source of truth for frontend gating.
- Authentication is enforced for the application shell: unauthenticated users receive the auth router, authenticated users receive `AppLayout` (`frontend/src/App.jsx:86`, `frontend/src/App.jsx:98`, `frontend/src/App.jsx:102`).
- Backend authorization middleware is real and fail-closed. Routes define `workflow:read`, `workflow:write`, `workflow:run`, `settings:manage`, `user:manage`, and `audit:read` (`backend/internal/api/routes/routes.go:27`, `backend/internal/api/routes/routes.go:28`, `backend/internal/api/routes/routes.go:33`); missing permission returns HTTP 403 (`backend/internal/api/middlewares/rbac.go:8`, `backend/internal/api/middlewares/rbac.go:15`).
- Existing role policy definitions are useful: Platform Admin has all permissions, Workflow Builder has workflow read/write/run, Execution Reviewer has read/run/audit, and Auditor has read/audit (`backend/internal/repository/memory.go:93`, `backend/internal/repository/memory.go:98`, `backend/internal/repository/memory.go:102`, `backend/internal/repository/memory.go:106`).
- Backend user management already supports list/create/get/update/delete, activation/suspension, role CRUD, permissions listing/matrix, and audit list/export (`backend/internal/api/routes/routes.go:103`, `backend/internal/api/routes/routes.go:120`). Assigning `roleId` through `PATCH /users/:id` copies the role and its permissions to the user (`backend/internal/api/handlers/admin_handler.go:85`, `backend/internal/api/handlers/admin_handler.go:100`).
- The frontend Users & Access page already composes a live user table, read-only permission matrix, audit table, and create-user form (`frontend/src/pages/users/UserListPage.jsx:9`, `frontend/src/pages/users/UserListPage.jsx:13`). Its service fetches `/users`, `/roles`, `/permissions/matrix`, and `/audit` together (`frontend/src/services/user.service.js:7`, `frontend/src/services/user.service.js:9`, `frontend/src/services/user.service.js:18`).
- Workflow list/create/detail/update/run APIs exist and are permission-gated; run specifically requires `workflow:run` (`backend/internal/api/routes/routes.go:49`, `backend/internal/api/routes/routes.go:58`). Creation records an owner and passes the full gate (`backend/internal/api/handlers/workflow_handler.go:28`, `backend/internal/api/handlers/workflow_handler.go:42`, `backend/internal/api/handlers/workflow_handler.go:54`). Execution records `StartedBy` (`backend/internal/api/handlers/execute_handler.go:60`, `backend/internal/api/handlers/execute_handler.go:64`).
- The workflow list, detail/run actions, visual builder, chat, executions, analytics, and audit display already consume backend data (`frontend/src/pages/workflows/WorkflowListPage.jsx:12`, `frontend/src/pages/workflows/WorkflowDetailPage.jsx:8`, `frontend/src/components/canvas/WorkflowBuilderCanvas.jsx:299`, `frontend/src/pages/chat/ChatPage.jsx:7`, `frontend/src/pages/executions/ExecutionListPage.jsx:10`, `frontend/src/pages/analytics/AnalyticsPage.jsx:12`, `frontend/src/components/users/AuditLogTable.jsx:3`). Reuse these screens with permission-aware modes.
- Tool catalog read support exists and is filtered to the current user's allowed role when no role query is supplied (`backend/internal/api/handlers/catalog_handler.go:12`, `backend/internal/api/handlers/catalog_handler.go:17`, `backend/internal/api/handlers/catalog_handler.go:33`). The MCP Bridge page already renders a read-only registry table (`frontend/src/pages/mcp_bridge/McpBridgePage.jsx:42`, `frontend/src/pages/mcp_bridge/McpBridgePage.jsx:52`).
- Rule catalog read support exists (`backend/internal/api/handlers/catalog_handler.go:88`, `backend/internal/api/handlers/catalog_handler.go:96`). Chat artifacts already know how to render retrieved rule/tool detail cards, so their visual primitives can be reused (`frontend/src/components/chat/ChatArtifactPanel.jsx:115`, `frontend/src/components/chat/ChatArtifactPanel.jsx:139`).
- Semantic index health, metadata, and rebuild endpoints exist (`backend/internal/api/routes/routes.go:74`, `backend/internal/api/routes/routes.go:76`, `backend/internal/api/handlers/catalog_handler.go:55`, `backend/internal/api/handlers/catalog_handler.go:77`). The Datafeed UI shows status/metadata and triggers the real rebuild endpoint (`frontend/src/pages/datafeed/DatafeedPage.jsx:7`, `frontend/src/pages/datafeed/DatafeedPage.jsx:10`, `frontend/src/pages/datafeed/DatafeedPage.jsx:24`).
- Backend integrations, webhooks, and workflow-platform API-key CRUD endpoints exist behind `settings:manage` (`backend/internal/api/routes/routes.go:127`, `backend/internal/api/routes/routes.go:152`, `backend/internal/api/handlers/settings_handler.go:88`, `backend/internal/api/handlers/settings_handler.go:163`, `backend/internal/api/handlers/profile_handler.go:67`).
- Audit list/detail/export already exist behind `audit:read` (`backend/internal/api/routes/routes.go:118`, `backend/internal/api/routes/routes.go:120`, `backend/internal/api/handlers/admin_handler.go:222`, `backend/internal/api/handlers/admin_handler.go:241`).

## Feature matrix

Size guide: **S** = localized UI/handler work; **M** = coordinated frontend/backend work; **L** = persistence, concurrency, authorization, or multi-service architecture.

| Portal feature | Frontend status | Backend status | Runtime-config ready? | Work needed |
|---|---|---|---|---|
| Login, registration, current identity | **EXISTS** — real forms and `AuthContext` (`frontend/src/App.jsx:73`, `frontend/src/context/AuthContext.jsx:54`) | **EXISTS** — bcrypt login/register, refresh, `/auth/me` (`backend/internal/api/routes/routes.go:17`, `backend/internal/api/routes/routes.go:36`) | Yes for current process; persistence is not production-ready | Reuse; later replace process-local identity storage (**L**, platform-wide) |
| Admin: list/create users | **EXISTS** (`frontend/src/pages/users/UserListPage.jsx:13`, `frontend/src/components/users/UserForm.jsx:14`) | **EXISTS** (`backend/internal/api/routes/routes.go:103`, `backend/internal/api/routes/routes.go:105`) | Runtime only; restart loses data | Reuse UI/API; add durable repository (**L**) |
| Admin: edit/delete/suspend users | **MISSING/PARTIAL** — table has no action controls (`frontend/src/components/users/UserRow.jsx:4`) | **EXISTS** (`backend/internal/api/routes/routes.go:107`, `backend/internal/api/routes/routes.go:110`) | Runtime only | Add row/detail actions, confirmations, error handling (**S**) |
| Admin: create/edit roles and permissions | **PARTIAL** — matrix is display-only (`frontend/src/components/users/PermissionMatrix.jsx:3`) | **EXISTS/PARTIAL** — role CRUD exists (`backend/internal/api/routes/routes.go:111`, `backend/internal/api/routes/routes.go:115`), but permission propagation is unsafe | Runtime only | Role editor plus backend propagation/validation fixes (**M**) |
| Admin: assign role to user | **PARTIAL** — create form assigns a role; no edit-user form (`frontend/src/components/users/UserForm.jsx:10`, `frontend/src/components/users/UserRow.jsx:4`) | **EXISTS** through `PATCH /users/:id` with `roleId` (`backend/internal/api/handlers/admin_handler.go:100`) | Runtime only | Reuse role selector in edit flow (**S**) |
| Admin: view tool registry | **EXISTS** read-only in MCP Bridge (`frontend/src/pages/mcp_bridge/McpBridgePage.jsx:44`) | **EXISTS** `GET /tools/catalog`, `workflow:read` (`backend/internal/api/routes/routes.go:71`) | Read-only snapshot | Reuse table/detail presentation (**S**) |
| Admin: add/edit tool schemas | **MISSING** — no create/edit service or screen found in settings, MCP Bridge, catalog service, or repo-wide API searches (`frontend/src/services/catalog.service.js:7`) | **MISSING** — no POST/PATCH tool route in `routes.go`; loader is startup-only (`backend/internal/core/registry/loader.go:24`) | **No** | Durable schema CRUD plus atomic reload of validator/executor/search consumers (**L**) |
| Admin: view rule registry | **PARTIAL** — contextual chat rule cards exist, but no standalone catalog-management page (`frontend/src/components/chat/ChatArtifactPanel.jsx:139`) | **EXISTS** `GET /rules/catalog`, `workflow:read` (`backend/internal/api/routes/routes.go:72`) | Read-only snapshot | Add admin list/detail using existing endpoint (**S**) |
| Admin: add/edit rules | **MISSING** — no rule catalog service/form found | **MISSING** — no POST/PATCH rule route in `routes.go` | **No** | Versioned rule CRUD, validation, audit, atomic reload (**L**) |
| Admin: semantic/RAG status and rebuild | **EXISTS** (`frontend/src/pages/datafeed/DatafeedPage.jsx:15`, `frontend/src/services/semantic.service.js:15`) | **EXISTS** (`backend/internal/api/handlers/catalog_handler.go:55`, `backend/internal/api/handlers/catalog_handler.go:77`) | Rebuild only, using current startup config | Reuse status/rebuild UI (**S**) |
| Admin: configure semantic/RAG provider/model/index | **PARTIAL** — effective values are read-only and UI explicitly says edit environment/restart (`frontend/src/pages/datafeed/PipelineConfigPage.jsx:16`) | **MISSING** config GET/PATCH; service exposes health/status/rebuild/search only (`backend/semantic_search_service/app.py:174`, `backend/semantic_search_service/app.py:223`) | **No** | Persist config, validate it, reinitialize embedder/index, audit changes (**M/L**) |
| Admin: view active LLM provider/model | **EXISTS** read-only (`frontend/src/components/settings/LlmModelSelector.jsx:1`) | **EXISTS** as a startup-derived settings projection (`backend/cmd/server/main.go:45`) | Read-only | Reuse display (**S**) |
| Admin: add/edit provider, model, provider API key, set active | **MISSING/PARTIAL** — no controls; settings update method is unused (`frontend/src/services/settings.service.js:19`) | **PARTIAL but ineffective** — generic LLM PATCH stores a map (`backend/internal/api/handlers/settings_handler.go:63`) but synthesizer never reads it | **No** | Encrypted secret store, provider-instance CRUD/test/activate, request-time provider factory (**L**) |
| Admin: integrations/webhooks/platform API keys | **PARTIAL** — webhook creation works; integrations and API keys are list-only (`frontend/src/components/settings/WebhookForm.jsx:13`, `frontend/src/components/settings/IntegrationCard.jsx:20`, `frontend/src/components/settings/ApiKeyCard.jsx:3`) | **EXISTS** CRUD/test/connect routes (`backend/internal/api/routes/routes.go:127`, `backend/internal/api/routes/routes.go:139`, `backend/internal/api/routes/routes.go:145`) | Runtime only; not durable | Complete existing forms/actions; persist secrets safely (**M/L**) |
| Admin: canvas/chat/flows/executions/analytics/audit | **PARTIAL** — all screens exist, but everyone sees the same controls (`frontend/src/App.jsx:37`, `frontend/src/constants/navigation.js:1`) | **EXISTS** with coarse permissions (`backend/internal/api/routes/routes.go:46`, `backend/internal/api/routes/routes.go:101`, `backend/internal/api/routes/routes.go:118`) | Operational, not ownership-scoped | Add route/feature gating; retain screens (**M**) |
| Client: use chat | **PARTIAL** — chat works but has no client mode (`frontend/src/pages/chat/ChatPage.jsx:7`) | **PARTIAL** — session creation/send require `workflow:write` (`backend/internal/api/routes/routes.go:80`, `backend/internal/api/routes/routes.go:84`) and sessions have no owner field (`backend/internal/models/settings.go:32`) | No client-safe authorization contract | Add `chat:use`, ownership, and limited UI mode (**M/L**) |
| Client: run only permitted workflows | **PARTIAL** — run controls are always rendered (`frontend/src/components/workflows/WorkflowActions.jsx:39`, `frontend/src/components/canvas/WorkflowBuilderCanvas.jsx:276`) | **PARTIAL** — route requires `workflow:run`, full gate receives user role, but list/get are not allowlist/owner-scoped (`backend/internal/api/routes/routes.go:58`, `backend/internal/api/handlers/handler.go:101`, `backend/internal/api/handlers/workflow_handler.go:15`) | No workflow-entitlement model | Define entitlement/visibility policy and enforce it server-side; hide editor controls (**L**) |
| Client: own executions/results only | **PARTIAL UI / MISSING backend isolation** — execution screens exist (`frontend/src/pages/executions/ExecutionListPage.jsx:10`) | **MISSING** — list and get return all matching executions without checking `StartedBy` (`backend/internal/api/handlers/execute_handler.go:120`, `backend/internal/api/handlers/execute_handler.go:157`) | No | Owner-scope list/get/log/timeline/healing and test cross-user denial (**L**) |
| Client: cannot edit tools/rules/models/users | **MISSING frontend / EXISTS backend for current admin APIs** — all nav links are shown (`frontend/src/components/navigation/Sidebar.jsx:25`) | Settings/users are permission-protected, but catalog reads use `workflow:read`; mutation routes do not yet exist (`backend/internal/api/routes/routes.go:31`, `backend/internal/api/routes/routes.go:32`) | Backend partially safe | Frontend hide/deny plus new mutation permission checks (**M**) |
| Role-specific canvas/chat/flows | **MISSING** — builder drag/drop/deploy/run is unconditional (`frontend/src/components/canvas/WorkflowBuilderCanvas.jsx:187`, `frontend/src/components/canvas/WorkflowBuilderCanvas.jsx:463`); list always shows New Workflow (`frontend/src/pages/workflows/WorkflowListPage.jsx:29`) | **PARTIAL** coarse read/write/run middleware exists | No | Add permission-driven screen modes and matching granular APIs (**M**) |
| Role-filtered sidebar/mobile navigation | **MISSING** — both map the full static array (`frontend/src/components/navigation/Sidebar.jsx:26`, `frontend/src/components/navigation/MobileNav.jsx:10`) | N/A | No | Add permission metadata and filter routes/nav (**S/M**) |
| Durable runtime changes across restart | **MISSING** | **MISSING** — repository is explicitly process-local and DB adapter reports memory mode (`backend/internal/repository/memory.go:21`, `backend/internal/config/db.go:11`, `backend/internal/config/db.go:15`) | **No** | Implement persistent repositories/migrations and secret encryption (**L**) |

## Task A — frontend inventory

### Auth and identity

| Item | Status | Evidence and current behavior |
|---|---|---|
| Login page | **EXISTS** | `frontend/src/pages/auth/LoginPage.jsx:25`; submits email/password through `AuthContext.login` at line 35. |
| Registration page | **EXISTS** | `frontend/src/pages/auth/RegisterPage.jsx:25`; submits name/email/password/organization at line 46. The backend ignores organization because its registration model/handler does not persist that field (`backend/internal/api/handlers/auth_handler.go:72`, `backend/internal/api/handlers/auth_handler.go:109`). |
| Current user storage | **EXISTS** | Session service stores `workflow.user` in local storage (`frontend/src/services/auth.service.js:3`, `frontend/src/services/auth.service.js:10`). `AuthContext` initializes from it and refreshes from `/auth/me` (`frontend/src/context/AuthContext.jsx:6`, `frontend/src/context/AuthContext.jsx:20`). |
| Exact role/permission availability | **EXISTS** | Backend returns `role`, `roleId`, and `permissions` (`backend/internal/api/handlers/handler.go:124`, `backend/internal/api/handlers/handler.go:126`); frontend exposes the object as `const { user } = useAuthContext()` through the context value (`frontend/src/context/AuthContext.jsx:101`, `frontend/src/context/AuthContext.jsx:103`). The top bar already renders `user.role` (`frontend/src/components/navigation/Topbar.jsx:42`, `frontend/src/components/navigation/Topbar.jsx:46`). |
| Authenticated-route wrapper | **PARTIAL** | `AppRouter` blocks unauthenticated users (`frontend/src/App.jsx:86`, `frontend/src/App.jsx:98`) but is not permission-aware. |
| Role/permission route guard | **MISSING** | NOT FOUND after inspecting `frontend/src/App.jsx`, `frontend/src/context/RouteContext.jsx`, `frontend/src/layouts/AppLayout.jsx`, Sidebar/MobileNav, and searching all `frontend/src/**/*.{js,jsx}` for `ProtectedRoute`, `RouteGuard`, `RoleGuard`, `AuthGuard`, `RequirePermission`, and `.can(`. The only permission helper found is unused and admin-only (`frontend/src/utils/permission.utils.js:1`). |
| Permission hook | **PARTIAL/UNSAFE** | `usePermissions` returns `can: () => true` and hard-codes `Platform Admin` (`frontend/src/hooks/usePermissions.js:1`). It is not a usable security or UI policy source. |

Frontend gating must use `user.permissions` for capabilities and `user.roleId` only for portal presentation. Local-storage state is user-modifiable, so backend middleware remains authoritative.

### Admin-relevant pages

| Item | Status | Evidence and current behavior |
|---|---|---|
| User list/create | **EXISTS** | Live aggregate page and create form (`frontend/src/pages/users/UserListPage.jsx:9`, `frontend/src/components/users/UserForm.jsx:14`). |
| User edit/delete/suspend | **MISSING** | `UserRow` only displays identity, role, status (`frontend/src/components/users/UserRow.jsx:4`); no service methods were found for update/delete. Backend routes can be reused. |
| Roles/permission editor | **PARTIAL** | Matrix renders Yes/No only (`frontend/src/components/users/PermissionMatrix.jsx:3`). `RolesPage` merely re-exports `UserListPage` (`frontend/src/pages/users/RolesPage.jsx:1`). No role mutation controls exist. |
| Settings shell | **PARTIAL** | Active routes all map to the same `SettingsPage` (`frontend/src/App.jsx:55`, `frontend/src/App.jsx:57`). `SettingsNav` labels General, Integrations, LLM Policy, RBAC, Webhooks, Billing but buttons have no navigation handler (`frontend/src/components/settings/SettingsNav.jsx:1`, `frontend/src/components/settings/SettingsNav.jsx:7`). |
| LLM fields exposed | **EXISTS read-only** | `provider` and `model` only (`frontend/src/pages/settings/SettingsPage.jsx:16`, `frontend/src/components/settings/LlmModelSelector.jsx:1`). The page explicitly says environment-managed (`frontend/src/pages/settings/SettingsPage.jsx:16`). No provider API-key field is rendered. |
| RBAC fields exposed | **EXISTS read-only** | Dynamically renders every backend RBAC key/value (`frontend/src/pages/settings/SettingsPage.jsx:16`). The environment-managed startup keys are `publicRegistrationEnabled` and `defaultRoleId`; the default role is Client. |
| General fields exposed | **MISSING** | Settings fetches `general` but the active page renders no general form/value (`frontend/src/pages/settings/SettingsPage.jsx:14`, `frontend/src/pages/settings/SettingsPage.jsx:16`). |
| Webhook fields exposed | **PARTIAL** | Create inputs: `name`, `url`; events are fixed to `execution.completed` and `execution.failed` (`frontend/src/components/settings/WebhookForm.jsx:9`, `frontend/src/components/settings/WebhookForm.jsx:17`, `frontend/src/components/settings/WebhookForm.jsx:23`). Existing rows show `name` and `url` (`frontend/src/pages/settings/SettingsPage.jsx:16`). No edit/delete/test controls. |
| Platform API-key fields exposed | **PARTIAL** | List displays `name` and `maskedKey` (`frontend/src/components/settings/ApiKeyCard.jsx:3`). No create/revoke/scope controls despite backend support. These are platform API keys, not LLM-provider credentials. |
| Integration fields exposed | **PARTIAL** | Displays `icon`, `status`, `name`, `type`; configure button is disabled (`frontend/src/components/settings/IntegrationCard.jsx:5`, `frontend/src/components/settings/IntegrationCard.jsx:20`). Service has list/create/test/connect/disconnect methods (`frontend/src/services/integration.service.js:4`) but the active UI does not invoke them. |
| Tool schema UI | **PARTIAL view / MISSING edit** | MCP Bridge lists tool ID/name/system/module/status and refreshes the GET query (`frontend/src/pages/mcp_bridge/McpBridgePage.jsx:42`, `frontend/src/pages/mcp_bridge/McpBridgePage.jsx:45`). No schema create/edit form/service. |
| Rule registry UI | **MISSING as admin UI** | NOT FOUND in settings pages/services, MCP Bridge, catalog service, or repo-wide search for `/rules/catalog`. Contextual rule cards in chat are not registry management (`frontend/src/components/chat/ChatArtifactPanel.jsx:139`). |
| Semantic/RAG UI | **PARTIAL** | Status, counts, embedding provider/model, index profile, cache/fingerprint, and rebuild exist (`frontend/src/pages/datafeed/DatafeedPage.jsx:27`, `frontend/src/pages/datafeed/DatafeedPage.jsx:34`). Pipeline config is explicitly read-only (`frontend/src/pages/datafeed/PipelineConfigPage.jsx:16`). |

### Shared operational screens

| Screen | Status/files | Role behavior today |
|---|---|---|
| Canvas / workflow builder | **EXISTS** — `frontend/src/pages/workflows/WorkflowBuilderPage.jsx:1`, `frontend/src/components/canvas/WorkflowBuilderCanvas.jsx:299` | **No role check.** Every authenticated user reaching it sees draggable tools, editable nodes/edges, Deploy and Run (`frontend/src/components/canvas/WorkflowBuilderCanvas.jsx:187`, `frontend/src/components/canvas/WorkflowBuilderCanvas.jsx:276`, `frontend/src/components/canvas/WorkflowBuilderCanvas.jsx:480`). Backend calls may return 403, but the screen does not render a limited mode. |
| Chat | **EXISTS** — `frontend/src/pages/chat/ChatPage.jsx:7`, `frontend/src/components/chat/ChatWindow.jsx:34` | **No role check.** Session create/rename/delete and send behavior are always supplied (`frontend/src/pages/chat/ChatPage.jsx:11`, `frontend/src/pages/chat/ChatPage.jsx:35`). |
| Workflows list | **EXISTS** — `frontend/src/pages/workflows/WorkflowListPage.jsx:12` | **No role check.** New Workflow is always rendered (`frontend/src/pages/workflows/WorkflowListPage.jsx:29`). |
| Workflow detail/run | **EXISTS** — `frontend/src/pages/workflows/WorkflowDetailPage.jsx:8` | **No role check.** `WorkflowActions` always renders Run and Export (`frontend/src/pages/workflows/WorkflowDetailPage.jsx:24`, `frontend/src/components/workflows/WorkflowActions.jsx:39`). |
| Executions/results/logs | **EXISTS** — `frontend/src/pages/executions/ExecutionListPage.jsx:10`, `frontend/src/pages/executions/ExecutionLogsPage.jsx:8` | **No role/ownership check.** Displays whatever backend lists; backend currently lists all. |
| Analytics | **EXISTS** — `frontend/src/pages/analytics/AnalyticsPage.jsx:12` | **No frontend role check.** Backend uses coarse `workflow:read` (`backend/internal/api/routes/routes.go:94`). |
| Audit | **EXISTS embedded** — `frontend/src/components/users/AuditLogTable.jsx:3`; `AuditLogPage` re-exports user page (`frontend/src/pages/users/AuditLogPage.jsx:1`) | **No frontend role check/export control.** Backend protects and supports export. |

### Navigation

**MISSING role filtering.** `NAVIGATION_GROUPS` statically contains Dashboard, Workflows, Chat, Executions, Analytics, Users, Settings, MCP Bridge, Datafeed, ERP Models, and Profile (`frontend/src/constants/navigation.js:1`, `frontend/src/constants/navigation.js:113`). Desktop and mobile navigation map that complete array without consulting `AuthContext`, role, or permissions (`frontend/src/components/navigation/Sidebar.jsx:25`, `frontend/src/components/navigation/MobileNav.jsx:10`). `ActivePage` also selects solely from route state (`frontend/src/App.jsx:67`). Thus client users see admin links and discover authorization only when API calls fail.

## Task B — backend endpoint inventory

All paths below are under the configured API base (default `/api`: `backend/internal/api/routes/routes.go:14`, `backend/internal/config/config.go:82`). “Authenticated” means JWT plus live-user check from the protected group (`backend/internal/api/routes/routes.go:27`).

### Users, roles, permissions, audit

| Capability | Status | Endpoint and required permission |
|---|---|---|
| List users | **EXISTS** | `GET /users` — `user:manage` (`backend/internal/api/routes/routes.go:103`) |
| Create user | **EXISTS** | `POST /users` — `user:manage` (`backend/internal/api/routes/routes.go:104`) |
| Update/assign role | **EXISTS** | `PATCH /users/:id` — `user:manage`; body `roleId` assigns role and cached permissions (`backend/internal/api/routes/routes.go:107`, `backend/internal/api/handlers/admin_handler.go:100`) |
| Delete user | **EXISTS** | `DELETE /users/:id` — `user:manage` (`backend/internal/api/routes/routes.go:108`) |
| Activate/suspend | **EXISTS** | `POST /users/:id/activate`, `POST /users/:id/suspend` — `user:manage` (`backend/internal/api/routes/routes.go:109`) |
| Invite | **PARTIAL / dead endpoint** | `POST /users/invite` is routed, but handler returns feature-not-configured (`backend/internal/api/routes/routes.go:105`, `backend/internal/api/handlers/admin_handler.go:126`) |
| Roles CRUD | **EXISTS** | `GET/POST /roles`, `GET/PATCH/DELETE /roles/:id` — `user:manage` (`backend/internal/api/routes/routes.go:111`, `backend/internal/api/routes/routes.go:115`) |
| Permissions list/matrix | **EXISTS** | `GET /permissions`, `GET /permissions/matrix` — `user:manage` (`backend/internal/api/routes/routes.go:116`) |
| Assign individual permission to user | **MISSING** | No endpoint in `routes.go`; permissions are copied only through role assignment (`backend/internal/api/handlers/admin_handler.go:100`). Prefer role-derived permissions unless per-user exceptions are a confirmed product requirement. |
| Audit list/detail/export | **EXISTS** | `GET /audit`, `GET /audit/:id`, `GET /audit/export` — `audit:read` (`backend/internal/api/routes/routes.go:118`) |

### Settings, models, integrations, registries, semantic index

| Capability | Status | Endpoint and required permission |
|---|---|---|
| Get/patch settings bundle | **EXISTS but process-local** | `GET/PATCH /settings` — `settings:manage` (`backend/internal/api/routes/routes.go:131`) |
| Get/patch LLM settings | **PARTIAL** | `GET/PATCH /settings/llm` — `settings:manage` (`backend/internal/api/routes/routes.go:135`). Generic map is stored/echoed but not applied to synthesizer (`backend/internal/api/handlers/settings_handler.go:56`, `backend/internal/api/handlers/settings_handler.go:63`). |
| Provider API-key management | **MISSING** | No secret-safe provider-credential endpoint/model. `/profile/api-keys` creates workflow-platform keys, not LLM keys (`backend/internal/api/routes/routes.go:127`, `backend/internal/api/handlers/profile_handler.go:74`). |
| Tool registry list | **EXISTS** | `GET /tools/catalog` — `workflow:read` (`backend/internal/api/routes/routes.go:71`) |
| Tool schema add/update/delete | **MISSING** | No route in `backend/internal/api/routes/routes.go:10-163`; no corresponding handler in `backend/internal/api/handlers/`. |
| Rule registry list | **EXISTS** | `GET /rules/catalog` — `workflow:read` (`backend/internal/api/routes/routes.go:72`) |
| Rule add/update/delete | **MISSING** | No route in `backend/internal/api/routes/routes.go:10-163`; no corresponding handler in `backend/internal/api/handlers/`. |
| Semantic status | **EXISTS** | `GET /semantic-index/health`, `GET /semantic-index/metadata` — `workflow:read` (`backend/internal/api/routes/routes.go:74`) |
| Semantic rebuild | **EXISTS** | `POST /semantic-index/rebuild` — `settings:manage` (`backend/internal/api/routes/routes.go:76`) |
| Semantic config get/update | **MISSING** | No config route in Go; external service exposes only health/status/rebuild/search (`backend/semantic_search_service/app.py:174`, `backend/semantic_search_service/app.py:223`) |
| Webhooks | **EXISTS** | List/create/update/delete/test under `/settings/webhooks` — `settings:manage` (`backend/internal/api/routes/routes.go:139`) |
| Integrations | **EXISTS** | List/create/get/update/delete/test/connect/disconnect under `/integrations` — `settings:manage` (`backend/internal/api/routes/routes.go:145`) |
| Platform API keys | **EXISTS** | List/create/delete under `/profile/api-keys` — `settings:manage` (`backend/internal/api/routes/routes.go:127`) |

### Workflows, execution, client isolation

| Capability | Status | Endpoint and required permission |
|---|---|---|
| List/create workflows | **EXISTS** | `GET /workflows` — `workflow:read`; `POST /workflows` — `workflow:write` (`backend/internal/api/routes/routes.go:49`) |
| Run workflow | **EXISTS and permission-gated** | `POST /workflows/:id/run` — `workflow:run` (`backend/internal/api/routes/routes.go:58`) |
| Role-aware deterministic validation | **EXISTS** | Gate receives current `user.Role.Name` (`backend/internal/api/handlers/handler.go:101`, `backend/internal/api/handlers/handler.go:104`); tool catalog is role-filtered (`backend/internal/api/handlers/catalog_handler.go:17`). |
| Permitted-workflow allowlist/assignment | **MISSING** | Workflow has owner but no client entitlement/assignment field (`backend/internal/models/workflow.go:39`, `backend/internal/models/workflow.go:43`); list returns every stored workflow (`backend/internal/api/handlers/workflow_handler.go:15`, `backend/internal/api/handlers/workflow_handler.go:18`). |
| Client's own executions only | **MISSING** | Execution records `StartedBy` (`backend/internal/models/state.go:12`, `backend/internal/models/state.go:22`), but list/get/log/timeline do not compare it with current user (`backend/internal/api/handlers/execute_handler.go:120`, `backend/internal/api/handlers/execute_handler.go:157`, `backend/internal/api/handlers/execute_handler.go:167`). |
| Client's own chat only | **MISSING** | Chat sessions have no owner/user ID (`backend/internal/models/settings.go:32`); list/get/update/delete operate across the process-global map (`backend/internal/api/handlers/chat_handler.go:78`, `backend/internal/api/handlers/chat_handler.go:104`, `backend/internal/api/handlers/chat_handler.go:129`). |

## Task C — runtime configuration without code changes

### 1. Tool and rule registries: definitively load-once

**Current answer: load-only startup snapshots; runtime add/edit without backend work does not exist.**

Evidence chain:

1. Paths come from environment at startup (`TOOL_REGISTRY_PATH`, `RULE_REGISTRY_PATH`: `backend/internal/config/config.go:67`, `backend/internal/config/config.go:71`).
2. `LoadBundle` reads and decodes both JSON files (`backend/internal/core/registry/loader.go:24`, `backend/internal/core/registry/loader.go:75`, `backend/internal/core/registry/loader.go:95`).
3. `main` calls the loader once, then constructs validator and semantic search from that bundle (`backend/cmd/server/main.go:54`, `backend/cmd/server/main.go:63`, `backend/cmd/server/main.go:64`).
4. The separate execution registry is populated once from the same startup bundle (`backend/cmd/server/main.go:67`, `backend/cmd/server/main.go:75`).
5. There are no mutation/reload routes; only GET catalogs (`backend/internal/api/routes/routes.go:71`, `backend/internal/api/routes/routes.go:72`).

There are in-memory `Add` methods, but they are not a runtime management solution. Tool `Add` appends without replacing/version recomputation (`backend/internal/core/registry/tool_registry.go:24`, `backend/internal/core/registry/tool_registry.go:77`); rule `Add` is not synchronized and also appends without version recomputation (`backend/internal/core/registry/rule_registry.go:19`, `backend/internal/core/registry/rule_registry.go:66`). A direct call would also leave the executor registry, semantic lexical cache, external index, and persisted JSON out of sync.

Required backend work (**L**):

- Introduce a persistent, versioned registry repository and validation schemas for tool/rule mutations.
- Add audited `POST`, `PATCH`, and preferably disable/version endpoints under a new `registry:manage` permission.
- Build a registry manager that validates a complete candidate snapshot, writes it transactionally/atomically, then swaps an immutable bundle under a lock or atomic pointer.
- Rebuild all coupled consumers in one operation: validator registry/hash, executable tool registry, semantic lexical cache, and external semantic index. Define what happens to validation tokens issued against the old registry hash and in-flight executions.
- On failure, retain the prior bundle and record the rejected mutation in audit. Never partially reload only the catalog view.

### 2. Model provider, model, and API key: startup-owned, except request model override

**Current answer: provider and API key are fixed at startup. The default model is fixed at startup, although an API caller may supply a model override for the already-selected provider. Settings PATCH does not affect the next generation call.**

Evidence chain:

1. Provider, Gemini key/model, Ollama URL/model/enabled are environment-loaded (`backend/internal/config/config.go:90`, `backend/internal/config/config.go:105`, `backend/internal/config/config.go:107`).
2. `main` constructs one synthesizer service from those values (`backend/cmd/server/main.go:52`).
3. Service stores a fixed `Provider` plus fixed Gemini/Ollama clients (`backend/internal/core/synthesizer/ollama_client.go:20`, `backend/internal/core/synthesizer/ollama_client.go:46`). The provider switch supports only `gemini` and `ollama` (`backend/internal/core/synthesizer/ollama_client.go:76`, `backend/internal/core/synthesizer/ollama_client.go:91`).
4. Gemini client stores the API key/model at construction (`backend/internal/core/synthesizer/gemini_client.go:14`, `backend/internal/core/synthesizer/gemini_client.go:21`).
5. `PATCH /settings/llm` only merges an in-memory map (`backend/internal/api/handlers/settings_handler.go:63`); the synthesizer has no reference to that map.
6. A request model can flow from the handler into `Synthesize` (`backend/internal/api/handlers/chat_handler.go:18`, `backend/internal/api/handlers/chat_handler.go:22`) and override the fixed client's default (`backend/internal/core/synthesizer/gemini_client.go:37`, `backend/internal/core/synthesizer/ollama_client.go:99`). The active chat UI sends mode only, not model (`frontend/src/components/chat/ChatWindow.jsx:34`, `frontend/src/components/chat/ChatWindow.jsx:48`).

Required backend work (**L**):

- Create provider-instance records: type, display name, base URL, allowed models, active model, enabled/tested state, and an encrypted credential reference. Return only `[REDACTED]`/last-four metadata.
- Add `settings:manage` or new `model:manage` CRUD/test/activate endpoints with input allowlists. Do not reuse the current generic map echo for secrets (`backend/internal/api/handlers/settings_handler.go:63`).
- Resolve the active provider snapshot per generation request (or atomically cached configuration with invalidation), then construct/use the correct client. Preserve safe connection pooling.
- If “new provider” means a new instance of a supported protocol, a generic OpenAI-compatible adapter can make it code-free. A genuinely new provider protocol still requires an adapter; the current hard-coded Gemini/Ollama switch cannot make arbitrary provider types code-free.

### 3. Semantic/RAG configuration: rebuild exists, live configuration does not

The Go service's mode/URL/fallback are fixed when constructed (`backend/internal/core/semanticsearch/service.go:78`, `backend/internal/core/semanticsearch/service.go:87`). The Python service reads dataset/provider/model/profile/index limits from environment into module-level values (`backend/semantic_search_service/app.py:77`, `backend/semantic_search_service/app.py:95`) and initializes the embedder/index on startup (`backend/semantic_search_service/app.py:137`). `/index/rebuild` reruns with those same values (`backend/semantic_search_service/app.py:214`). Therefore the existing rebuild button is real, but it cannot change provider/model/index policy.

Required backend/service work (**M/L**): persistent validated config; secret-safe embedding-provider credentials; config GET/PATCH/test; controlled reinitialization of embedder and index; atomic readiness transition; rollback to prior config/index; and audit records. Keep the existing status/rebuild UI and endpoints.

### 4. What already changes at runtime

- Users, role assignments, role definitions, integrations, webhooks, and workflow-platform API keys can change within the running process (`backend/internal/api/routes/routes.go:103`, `backend/internal/api/routes/routes.go:152`).
- Workflows can be created/edited/run, and semantic index rebuild can be triggered against current configuration (`backend/internal/api/routes/routes.go:49`, `backend/internal/api/routes/routes.go:76`).
- An API client can choose a model string for the current provider on an individual synthesis request (`backend/internal/api/handlers/chat_handler.go:18`, `backend/internal/core/synthesizer/ollama_client.go:76`).
- None of the process-store mutations survive restart because `Store` is in memory and the database adapter is only a placeholder (`backend/internal/repository/memory.go:21`, `backend/internal/config/db.go:15`).

## Backend gaps first — critical path before UI

1. **Define and enforce resource scope (L, must build).** Add an explicit Client role/permission contract, workflow entitlement or ownership rules, `chat:use`, and own-execution/chat checks. Apply checks to list and object endpoints, including logs/timeline/healing. Add cross-user denial tests. Existing permission middleware is reused.
2. **Add durable repositories and secret storage (L, must build).** Users/roles/config/integrations/webhooks/keys/registry data currently reset on restart. Introduce database migrations/repositories and envelope encryption or an external secret manager. Reuse current models only where their exposure rules are safe.
3. **Build a runtime Registry Manager (L, must build).** Add versioned tool/rule CRUD, schema validation, audit, atomic snapshot reload, executor synchronization, token-version behavior, semantic cache/index rebuild, and rollback. Reuse catalog models, loaders, validator, and GET catalog handlers.
4. **Build active LLM provider configuration (L, must build).** Add provider-instance/credential endpoints, connection tests, active selection, request-time resolution, and redacted responses. Reuse Gemini/Ollama clients behind a factory.
5. **Build semantic config endpoints and service reconfiguration (M/L, must build).** Add config read/update/test and controlled reinitialize. Reuse health/status/rebuild endpoints and Datafeed views.
6. **Fix role consistency (M, must build).** `UpdateRole` changes only the role record (`backend/internal/api/handlers/admin_handler.go:175`), while users cache copied permissions (`backend/internal/api/handlers/admin_handler.go:103`); existing users do not automatically receive edited permissions. Choose normalized role lookup per request or transactionally propagate changes. Permit clearing a role's permissions, validate deletion/reassignment, and audit role/user updates.
7. **Complete existing admin CRUD semantics (S/M, must build selectively).** Implement invitation or remove its dead route/button plan; validate integration configs; add API-key ownership/scopes and one-time secret response; add update/delete audit records. Reuse existing routes where behavior is already real.

## Shortest demo-complete path

1. **Lock the role contract and tests (reuse + must build).** Keep `role_admin`, `role_builder`, `role_reviewer`, and `role_auditor`; add `role_client`. Introduce granular `chat:use` and ownership/entitlement checks. Prove admin access, client allowed access, and cross-client 403/404 behavior before UI changes.
2. **Make frontend identity/permissions real (must build, S).** Replace hard-coded `usePermissions` with `AuthContext.user.permissions`; add `can`, `canAny`, portal mode, denied-state redirect, and permission metadata on route/navigation entries. Reuse `AuthContext`, `AppRouter`, and current navigation array.
3. **Create role modes for shared screens (must build, M).** Reuse current pages. Admin/builder gets editable canvas, tool drag/drop, New/Deploy, chat management, and full workflow actions. Client gets accessible workflow list/detail, Run, own results, and chat; canvas/flow preview is read-only and edit/deploy controls are absent.
4. **Finish user/role administration (reuse + must build, S/M).** Reuse user table/form/matrix and backend CRUD. Add edit/delete/suspend, role selector, role permission editor, confirmations, and propagation behavior.
5. **Deliver registry backend before registry forms (must build, L).** Implement the Registry Manager and tests, then extend the existing MCP catalog table and chat rule-card styles into admin tool/rule list/detail/editor screens.
6. **Deliver provider backend before LLM form (must build, L).** Implement secret-safe provider APIs/factory, then convert the existing LLM card into provider/model/API-key/test/activate forms.
7. **Add semantic configuration (reuse + must build, M/L).** Extend existing Datafeed read-only page with validated controls only after service config/reinitialize endpoints work; retain the current rebuild/status experience.
8. **Complete integrations/API-key controls (reuse + must build, M).** Wire existing frontend service methods and backend routes into create/edit/test/connect/disconnect/revoke flows.
9. **Panel-demo hardening (must build).** Seed/admin-provision accounts safely, persist demo data, test page refresh/restart, verify navigation and direct-route denial, run two-browser cross-user isolation tests, and demonstrate audit entries for every admin mutation.

## Role model

Permissions should be authoritative; role IDs select a coherent portal presentation. Do not hard-code access from a display-name string.

| Role | Existing/new | What it sees and does |
|---|---|---|
| `role_admin` / Platform Admin | Existing; extend with `registry:manage`, `model:manage`, `semantic:manage` or keep these under a deliberately broad `settings:manage` | All navigation and data; edit tools/rules/models/semantic config/users/roles; full canvas/chat/workflow lifecycle; all executions/analytics/audit. Existing all-permission setup is at `backend/internal/repository/memory.go:94`. |
| `role_client` / Client | **New** | Chat through `chat:use`; list/view/run only workflows explicitly entitled to the user/organization; read-only flow/canvas preview; own executions/logs/results only; no Users, Settings, MCP Registry, Datafeed config, model configuration, or global analytics/audit. |
| `role_builder` / Workflow Builder | Existing | Current workflow read/write/run, editable builder and chat synthesis; no users/settings/audit unless explicitly granted (`backend/internal/repository/memory.go:98`). |
| `role_reviewer` / Execution Reviewer | Existing | Workflow/flow read, permitted run, execution review, audit read; no editing/settings/users (`backend/internal/repository/memory.go:102`). Resource scope still needs a product decision. |
| `role_auditor` / Auditor | Existing | Read-only workflows/execution evidence and audit; no run/edit/admin configuration (`backend/internal/repository/memory.go:106`). |

Frontend implementation source:

1. `AuthContext.user` already contains `role`, `roleId`, and `permissions` (`frontend/src/context/AuthContext.jsx:101`, `backend/internal/api/handlers/handler.go:124`).
2. Implement `usePermissions()` from that object, not the current hard-coded return (`frontend/src/hooks/usePermissions.js:1`).
3. Add required permissions/portal modes to `routeComponents` and `NAVIGATION_GROUPS` (`frontend/src/App.jsx:37`, `frontend/src/constants/navigation.js:1`). Filter desktop/mobile navigation and guard `ActivePage`.
4. Pass capability flags/read-only mode into Workflow list/detail/builder/chat/execution components. UI gating improves clarity only; every backend endpoint retains permission and resource-scope enforcement.

## Risks and unknowns

- **Verified risk — no persistence.** Database/Redis constructors explicitly stay offline/in-memory (`backend/internal/config/db.go:11`, `backend/internal/config/redis.go:11`). Exact resolution check: restart after creating a user/workflow/integration and confirm it disappears; then select/implement the real repository adapter.
- **Verified risk — frontend authorization is absent.** NOT FOUND in the inspected router/layout/navigation and repo-wide guard search. Exact completion check: component tests for admin/client nav plus direct activation of a forbidden route.
- **Verified risk — coarse permission conflation.** `workflow:read` currently grants dashboards, catalogs, executions, analytics, and semantic status (`backend/internal/api/routes/routes.go:41`, `backend/internal/api/routes/routes.go:100`). Decide whether clients may see global analytics/catalogs; split permissions if not.
- **Verified risk — object ownership is missing.** Workflows have an owner and executions have `StartedBy`, but handlers do not enforce them; chats have no owner (`backend/internal/models/workflow.go:43`, `backend/internal/models/state.go:22`, `backend/internal/models/settings.go:32`). Exact completion check: integration tests using two client users against every list/get/log endpoint.
- **Verified risk — role permission drift.** Users cache permissions at assignment while role edits do not propagate (`backend/internal/api/handlers/admin_handler.go:100`, `backend/internal/api/handlers/admin_handler.go:175`). Exact resolution check: update a role then request a protected endpoint with an already-assigned user.
- **Verified risk — public registration bootstraps admin then defaults to Workflow Builder, not Client** (`backend/internal/api/handlers/auth_handler.go:96`). Decide whether production registration is disabled, invite-only, or defaults to `role_client`.
- **Verified risk — generic LLM settings could echo a submitted secret.** `PatchLLMSettings` accepts/returns arbitrary map contents (`backend/internal/api/handlers/settings_handler.go:63`). Do not put provider keys there; use write-only encrypted credential endpoints and redacted DTOs.
- **Verified risk — tool/rule reload touches token safety.** Validation tokens bind registry hash; a reload strategy must define old-token/in-flight behavior. Exact check: concurrency tests validating immediately before/during/after a registry swap.
- **Unknown — “permitted workflows” policy definition.** NOT FOUND as an entitlement/assignment model in workflow models/handlers. Product must choose owner-only, explicit user/role assignment, organization, tags, or policy-derived visibility before implementation.
- **Unknown — provider protocol scope.** “Add provider without code” is achievable only for supported/generic protocols. Confirm whether the demo needs Gemini/Ollama instances only, OpenAI-compatible providers, or arbitrary provider plugins.
- **Unknown — durable registry source of truth.** Current source is JSON. Decide database versus versioned files/object storage and whether admin changes must round-trip to repository JSON. This decision precedes mutation endpoints.
- **Unknown — semantic service deployment control.** The API can call rebuild but cannot currently restart/reconfigure the Python service. Confirm whether both services share a database/config service and whether zero-downtime index swaps are required.

## Five-line handoff summary

1. **Already present:** approximately **45%** of requested capability is reusable, especially auth, backend RBAC, operational screens, user/role APIs, catalog reads, integrations, and semantic status/rebuild.
2. **Biggest backend gap:** durable, audited, atomic tool/rule registry CRUD and reload across validator, executor, and semantic consumers.
3. **Runtime config without code:** works only for process-local users/roles/integrations/webhooks/platform keys, current-config index rebuild, and per-request model override; tool/rule, active provider secret, and semantic config do **not** work.
4. **Portal security gap:** frontend role gating is **NOT FOUND**, and backend own-workflow/execution/chat scoping is **MISSING**.
5. **Double-check before build:** permitted-workflow policy, provider protocol scope, durable registry source of truth, semantic deployment topology, and whether clients may see global analytics/catalog data.
