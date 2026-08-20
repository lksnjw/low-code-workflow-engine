# Supported feature and API matrix

This matrix describes the routes registered by the current frontend router and backend `routes.Register`. It distinguishes a reachable browser workflow from an endpoint that merely exists.

Status meanings:

- **UI-supported** — a reachable current screen calls the route, or the route is part of the browser shell/auth flow.
- **API-only** — registered and available to an API client, but no reachable current screen calls it.
- **STUB** — deliberately registered but returns “not implemented/not configured,” or exposes only the documented placeholder behavior.
- **deprecated** — retained only for compatibility. No current route is deprecated; removed dead aliases and `/erp-models` are not registered compatibility routes.

All `/api` routes inherit the configured API base path. “Authenticated” means a valid session is required but no additional named permission middleware is attached.

## Browser routes

| Browser route | Current screen | Required frontend permission | Status |
|---|---|---|---|
| `/` | Dashboard — Overview | `workflow:read` | UI-supported |
| `/activity` | Dashboard — Activity | `workflow:read` | UI-supported |
| `/company` | Company | authenticated | UI-supported |
| `/workflows` | Workflows | `workflow:read` or `workflow:read_own` | UI-supported |
| `/builder` | Workflow Builder | `workflow:write` | UI-supported |
| `/builder/:workflowId` | Workflow Builder | `workflow:write` | UI-supported |
| `/workflows/templates` | Workflow Templates | `workflow:read` | UI-supported |
| `/workflows/:workflowId` | Workflow Detail | `workflow:read` or `workflow:read_own` | UI-supported |
| `/chat` | Chat Workspace | `chat:use` or `workflow:write` | UI-supported |
| `/chat/:sessionId` | Chat Workspace | `chat:use` or `workflow:write` | UI-supported |
| `/chat/history` | Chat History | `chat:use` or `workflow:write` | UI-supported |
| `/executions` | Execution History | `workflow:read` or `execution:read_own` | UI-supported |
| `/executions/logs` | Execution Logs | `workflow:read` or `execution:read_own` | UI-supported |
| `/executions/healing` | Healing Reports | `workflow:read` or `execution:read_own` | UI-supported |
| `/executions/:executionId` | Execution Detail | `workflow:read` or `execution:read_own` | UI-supported |
| `/analytics/performance` | Analytics — Performance | `workflow:read` | UI-supported |
| `/analytics/usage` | Analytics — Usage | `workflow:read` | UI-supported |
| `/analytics/healing` | Analytics — Self-Healing | `workflow:read` | UI-supported |
| `/users` | User Directory | `user:manage` | UI-supported |
| `/roles` | Roles | `user:manage` | UI-supported |
| `/audit` | Audit Log | `audit:read` | UI-supported |
| `/settings` | General Settings | `settings:manage` | UI-supported |
| `/settings/integrations` | Integrations | `settings:manage` | UI-supported |
| `/settings/llm` | LLM Policy | `settings:manage` | UI-supported |
| `/settings/providers` | Model Providers | `provider:manage` | UI-supported |
| `/registry/tools` | Tool Registry | `registry:read` | UI-supported |
| `/registry/rules` | Rule Registry | `registry:read` | UI-supported |
| `/registry/import` | Registry Import | `registry:write` | UI-supported |
| `/registry/context` | Generation Context | `registry:read` | UI-supported |
| `/mcp-bridge` | MCP Bridge | `workflow:read` | UI-supported |
| `/datafeed` | Semantic Index Status | `workflow:read` | UI-supported |
| `/datafeed/metrics` | Semantic Index Metrics | `workflow:read` | UI-supported |
| `/datafeed/configuration` | Semantic Pipeline Configuration | `workflow:read` | UI-supported |
| `/registry-search` | Semantic Registry Search | `workflow:read` | UI-supported |
| `/profile` | My Profile | authenticated | UI-supported |
| `/profile/security` | Security | authenticated | UI-supported (read-only; mutation API is STUB) |
| `/login` | Login | public | UI-supported |
| `/register` | Registration | public; server may disable public registration | UI-supported |
| `/forgot-password` | Password Recovery | public | STUB |
| `/unauthorized` | Access Denied | public | UI-supported |
| `*` | Page Not Found | public | UI-supported |

## Backend routes

### Health, realtime, and authentication

| Registered route(s) | Permission | Current screen | Status |
|---|---|---|---|
| `GET /healthz` | public | — | API-only |
| `GET /api/health` | public | Application shell / top bar | UI-supported |
| `GET /ws/*` | authenticated | — | API-only; no browser socket consumer |
| `POST /api/auth/login` | public | Login | UI-supported |
| `POST /api/auth/register` | public; configuration-controlled | Registration | UI-supported |
| `POST /api/auth/refresh` | public token exchange | Axios auth session | UI-supported |
| `POST /api/auth/forgot-password` | public | Password Recovery | STUB |
| `POST /api/auth/reset-password`<br>`POST /api/auth/verify-email`<br>`GET /api/auth/oauth/:provider/authorize`<br>`GET /api/auth/oauth/:provider/callback` | public | — | STUB |
| `POST /api/auth/logout`<br>`GET /api/auth/me` | authenticated | Authenticated application shell | UI-supported |
| `POST /api/auth/2fa/verify`<br>`POST /api/auth/2fa/enable`<br>`POST /api/auth/2fa/disable` | authenticated | — | STUB |

### Company and dashboard

| Registered route(s) | Permission | Current screen | Status |
|---|---|---|---|
| `GET /api/company`<br>`PUT /api/company` | authenticated | Company | UI-supported |
| `GET /api/company/departments`<br>`POST /api/company/departments`<br>`PUT /api/company/departments/:id`<br>`DELETE /api/company/departments/:id` | authenticated | Company; department GET is also used by User Directory | UI-supported |
| `GET /api/company/cost-centres`<br>`POST /api/company/cost-centres`<br>`PUT /api/company/cost-centres/:id`<br>`DELETE /api/company/cost-centres/:id` | authenticated | Company | UI-supported |
| `GET /api/company/approval-tiers`<br>`POST /api/company/approval-tiers`<br>`PUT /api/company/approval-tiers/:id`<br>`DELETE /api/company/approval-tiers/:id` | authenticated | Company | UI-supported |
| `GET /api/dashboard/summary`<br>`GET /api/dashboard/activity`<br>`GET /api/dashboard/health`<br>`GET /api/dashboard/recent-workflows` | `workflow:read` | Dashboard Overview / Activity | UI-supported |

### Workflows and generation

| Registered route(s) | Permission | Current screen | Status |
|---|---|---|---|
| `GET /api/workflows/templates` | `workflow:read` | Workflow Templates | UI-supported |
| `POST /api/workflows/templates` | `workflow:write` | — | API-only |
| `POST /api/workflows/templates/:id/use` | `workflow:write` | Workflow Templates | UI-supported |
| `GET /api/workflows` | `workflow:read` or `workflow:read_own` | Workflows | UI-supported |
| `POST /api/workflows` | `workflow:write` | Workflow Builder | UI-supported |
| `GET /api/workflows/assignable-users` | `workflow:write` | Workflow Detail | UI-supported |
| `GET /api/workflows/:id` | `workflow:read` or `workflow:read_own` | Workflow Detail / Builder | UI-supported |
| `PATCH /api/workflows/:id`<br>`DELETE /api/workflows/:id`<br>`POST /api/workflows/:id/duplicate`<br>`POST /api/workflows/:id/archive` | `workflow:write` | — | API-only |
| `POST /api/workflows/:id/publish` | `workflow:write` | Workflow Builder | UI-supported |
| `POST /api/workflows/:id/validate` | `workflow:read` | — | API-only |
| `POST /api/workflows/:id/run` | `workflow:run` or `workflow:run_own` | Workflow Detail / Builder | UI-supported; synchronous |
| `POST /api/workflows/:id/assign`<br>`DELETE /api/workflows/:id/assign/:userId` | `workflow:write` | Workflow Detail | UI-supported |
| `GET /api/workflows/:id/yaml` | `workflow:read` or `workflow:read_own` | Workflow Detail / Builder | UI-supported |
| `PUT /api/workflows/:id/yaml` | `workflow:write` | Workflow Builder | UI-supported |
| `GET /api/workflows/:id/canvas` | `workflow:read` or `workflow:read_own` | — | API-only |
| `PUT /api/workflows/:id/canvas` | `workflow:write` | — | API-only |
| `GET /api/workflows/:id/versions` | `workflow:read` or `workflow:read_own` | — | API-only |
| `POST /api/workflows/:id/restore/:versionId` | `workflow:write` | — | API-only |
| `GET /api/workflows/:id/executions` | `workflow:read` or `workflow:read_own` | — | API-only |
| `POST /api/synthesis` | `workflow:write` | — | API-only |
| `POST /api/synthesis/validate`<br>`POST /api/synthesis/preview-flow`<br>`POST /api/synthesis/explain` | `workflow:read` | — | API-only |
| `GET /api/tools/catalog` | `workflow:read` | Workflow Builder | UI-supported |
| `GET /api/rules/catalog` | `workflow:read` | — | API-only |
| `POST /api/semantic-search` | `workflow:read` | Semantic Registry Search | UI-supported |
| `GET /api/semantic-index/health`<br>`GET /api/semantic-index/metadata` | `workflow:read` | Semantic Index screens | UI-supported |
| `POST /api/semantic-index/rebuild` | `settings:manage` | Semantic Index Status; permission-gated | UI-supported |
| `POST /api/canvas/validate-workflow` | `workflow:read` | — | STUB for node/edge input; accepts prebuilt YAML only |

### Registry and imports

| Registered route(s) | Permission | Current screen | Status |
|---|---|---|---|
| `GET /api/registry/tools`<br>`GET /api/registry/rules` | `registry:read` | Tool Registry / Rule Registry | UI-supported |
| `GET /api/registry/status` | `registry:read` | Registry status banner | UI-supported |
| `GET /api/registry/context`<br>`GET /api/registry/context/history` | `registry:read` | Generation Context | UI-supported |
| `POST /api/registry/context/regenerate` | `registry:write` | Generation Context | UI-supported |
| `POST /api/registry/tools/import`<br>`POST /api/registry/rules/import` | `settings:manage` | Registry bulk-import panel | UI-supported |
| `POST /api/registry/tools`<br>`PUT /api/registry/tools/:id`<br>`POST /api/registry/rules`<br>`PUT /api/registry/rules/:id` | `registry:write` | Tool Registry / Rule Registry | UI-supported |
| `POST /api/import/analyse`<br>`POST /api/import/commit`<br>`GET /api/import/history` | `registry:write` | Registry Import | UI-supported |

### Chat, execution, and analytics

| Registered route(s) | Permission | Current screen | Status |
|---|---|---|---|
| `GET /api/chat/sessions`<br>`GET /api/chat/sessions/:id` | `workflow:read` or `chat:use` | Chat Workspace / History | UI-supported |
| `POST /api/chat/sessions`<br>`PATCH /api/chat/sessions/:id`<br>`DELETE /api/chat/sessions/:id`<br>`POST /api/chat/sessions/:id/messages` | `workflow:write` or `chat:use` | Chat Workspace / History | UI-supported |
| `GET /api/executions`<br>`GET /api/executions/:id`<br>`GET /api/executions/:id/logs`<br>`GET /api/executions/:id/timeline`<br>`GET /api/executions/:id/healing-report` | `workflow:read` or `execution:read_own` | Execution History / Logs / Healing / Detail | UI-supported |
| `POST /api/executions/:id/cancel` | `workflow:run` | — | STUB; returns HTTP 501 |
| `POST /api/executions/:id/retry` | `workflow:run` or `workflow:run_own` | — | API-only |
| `GET /api/analytics/summary`<br>`GET /api/analytics/performance`<br>`GET /api/analytics/usage`<br>`GET /api/analytics/self-healing`<br>`GET /api/analytics/latency`<br>`GET /api/analytics/f1-score`<br>`GET /api/analytics/activity-heatmap`<br>`GET /api/analytics/cost-trends` | `workflow:read` | Analytics screens | UI-supported |

### Users, roles, and audit

| Registered route(s) | Permission | Current screen | Status |
|---|---|---|---|
| `GET /api/users`<br>`POST /api/users` | `user:manage` | User Directory | UI-supported |
| `POST /api/users/invite` | `user:manage` | — | STUB |
| `GET /api/users/:id`<br>`DELETE /api/users/:id`<br>`POST /api/users/:id/activate`<br>`POST /api/users/:id/suspend` | `user:manage` | — | API-only |
| `PATCH /api/users/:id`<br>`PUT /api/users/:id/role`<br>`PUT /api/users/:id/status` | `user:manage` | User Directory | UI-supported |
| `GET /api/roles`<br>`POST /api/roles`<br>`PUT /api/roles/:id`<br>`DELETE /api/roles/:id` | `user:manage` | Roles | UI-supported |
| `GET /api/roles/:id`<br>`PATCH /api/roles/:id` | `user:manage` | — | API-only |
| `GET /api/permissions`<br>`GET /api/permissions/matrix` | `user:manage` | Roles / User Directory | UI-supported |
| `GET /api/audit` | `audit:read` | Audit Log | UI-supported |
| `GET /api/audit/export`<br>`GET /api/audit/:id` | `audit:read` | — | API-only |

### Profile, settings, providers, and integrations

| Registered route(s) | Permission | Current screen | Status |
|---|---|---|---|
| `GET /api/profile`<br>`PATCH /api/profile` | authenticated | My Profile | UI-supported |
| `PATCH /api/profile/security` | authenticated | — | STUB |
| `GET /api/profile/notifications`<br>`PATCH /api/profile/notifications` | authenticated | — | API-only |
| `GET /api/profile/api-keys` | `settings:manage` | General Settings | UI-supported |
| `POST /api/profile/api-keys`<br>`DELETE /api/profile/api-keys/:id` | `settings:manage` | — | API-only |
| `GET /api/settings` | `settings:manage` | Settings screens | UI-supported |
| `PATCH /api/settings` | `settings:manage` | — | API-only |
| `GET /api/settings/general`<br>`PATCH /api/settings/general`<br>`GET /api/settings/llm`<br>`PATCH /api/settings/llm`<br>`GET /api/settings/rbac`<br>`PATCH /api/settings/rbac` | `settings:manage` | — | API-only |
| `GET /api/providers`<br>`POST /api/providers`<br>`PUT /api/providers/:id`<br>`POST /api/providers/:id/activate`<br>`POST /api/providers/:id/test` | `provider:manage` | Model Providers | UI-supported |
| `GET /api/settings/webhooks`<br>`POST /api/settings/webhooks` | `settings:manage` | Integrations | UI-supported |
| `PATCH /api/settings/webhooks/:id`<br>`DELETE /api/settings/webhooks/:id`<br>`POST /api/settings/webhooks/:id/test` | `settings:manage` | — | API-only |
| `GET /api/integrations` | `settings:manage` | Integrations | UI-supported |
| `POST /api/integrations`<br>`GET /api/integrations/:id`<br>`PATCH /api/integrations/:id`<br>`DELETE /api/integrations/:id`<br>`POST /api/integrations/:id/test`<br>`POST /api/integrations/:id/connect`<br>`POST /api/integrations/:id/disconnect` | `settings:manage` | — | API-only |

### Notifications and uploads

| Registered route(s) | Permission | Current screen | Status |
|---|---|---|---|
| `GET /api/notifications` | authenticated | Application top bar | UI-supported |
| `PATCH /api/notifications/read-all`<br>`PATCH /api/notifications/:id/read`<br>`DELETE /api/notifications/:id` | authenticated | — | API-only |
| `POST /api/upload`<br>`DELETE /api/upload/:id`<br>`POST /api/upload/workflow-import` | `workflow:write` | — | API-only |
| `GET /api/upload/:id`<br>`GET /api/upload/:id/download` | `workflow:read` | — | API-only |

## Explicitly absent/deprecated routes

- No route is currently registered as deprecated.
- `/erp-models` was removed instead of retained as a misleading compatibility alias; semantic registry retrieval is now `/registry-search`.
- Unrouted page re-export aliases do not represent supported routes. The auth alias files are retained only as placeholders for the separately scoped future auth lifecycle and are not claimed as routed screens.
