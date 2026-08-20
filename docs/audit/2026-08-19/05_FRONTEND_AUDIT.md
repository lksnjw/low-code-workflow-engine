# Frontend audit

## Pages and real/mock split

The BrowserRouter exposes dashboard, company, workflows/builder/templates/detail, chat/history, executions/logs/healing/detail, analytics, users/roles/audit, settings/providers, registry/import/context, MCP, datafeed, ERP-model search, profile/security, and public auth/error routes (`frontend/src/config/router.jsx:17-89`, `frontend/src/config/router.jsx:177-202`). These routed pages use API service modules rather than page-local mock arrays; services call the Go routes (`frontend/src/services/workflow.service.js:21-75`, `frontend/src/services/execution.service.js:1-40`, `frontend/src/services/analytics.service.js:4-27`).

| Surface | Status | Evidence |
|---|---|---|
| Auth/profile/company/dashboard | IMPLEMENTED against backend, with loading/error handling (`frontend/src/context/AuthContext.jsx:23-145`, `frontend/src/pages/company/CompanyPage.jsx:24-194`, `frontend/src/pages/dashboard/DashboardPage.jsx:8-47`). |
| Workflow list/detail/YAML/canvas/run | IMPLEMENTED against backend (`frontend/src/services/workflow.service.js:21-75`, `frontend/src/pages/workflows/WorkflowBuilderPage.jsx:1-11`). |
| Chat generation | IMPLEMENTED against backend candidate pipeline (`frontend/src/services/chat.service.js:1-38`, `frontend/src/pages/chat/ChatPage.jsx:10-71`). |
| Execution views | PARTIAL: persisted log display, not streaming; cancel absent because backend is STUB (`frontend/src/pages/executions/ExecutionLogsPage.jsx:22-36`, `backend/internal/api/handlers/execute_handler.go:453-455`). |
| Analytics | IMPLEMENTED over backend-derived values; F1 explicitly N/A, not fabricated (`frontend/src/services/analytics.service.js:4-27`, `frontend/src/components/analytics/F1ScoreGauge.jsx:1-7`). |
| Settings/integrations/providers/registry | PARTIAL administrative records and probes; not proof of live runner integration (`frontend/src/pages/settings/SettingsPage.jsx:10-66`, `frontend/src/pages/models/ModelsPage.jsx:85-161`, `frontend/src/pages/registry/RegistryPage.jsx:130-206`). |
| Unrouted page files | DEAD relative to router search: older `WorkflowNewPage`, OAuth/2FA/reset/verify and several alias pages are not in `lazyRouteComponents` (`frontend/src/config/router.jsx:17-48`, `frontend/src/pages/workflows/WorkflowNewPage.jsx:1-3`). |

The only runtime MOCKED ERP behavior is backend MCP mock mode; the frontend merely displays the backend-reported `mock-erp` marker (`frontend/src/components/navigation/Topbar.jsx:110-138`, `backend/internal/tools/mcp_client.go:104-119`). Test mocks originate under `frontend/src/tests/__mocks__` and mocked service calls in component tests (`frontend/src/tests/__mocks__/axios.js:1-10`, `frontend/src/components/workflows/WorkflowActions.test.jsx:29-62`).

## Canvas and validation UX

React Flow drag/connect/render and backend catalog loading are real; YAML/canvas persistence uses backend endpoints (`frontend/src/components/canvas/WorkflowBuilderCanvas.jsx:1-260`, `frontend/src/services/workflow.service.js:47-57`). Canvas-to-executable YAML conversion is PARTIAL: semantic canvas changes are stored as unvalidated and execution refuses until YAML validation, rather than reliably compiling arbitrary nodes into YAML (`backend/internal/api/handlers/gate_invariant_test.go:158-178`, `frontend/src/utils/workflowCanvas.utils.js:1-129`). Run is real via `/workflows/:id/run`, not simulated (`frontend/src/services/workflow.service.js:62-69`).

Validation details are surfaced in chat candidate reports, but the canvas panel itself contains generic check labels and does not present the durable approval principal, policy/model version, or registry evidence required by G4/G5 (`frontend/src/components/canvas/panels/ValidationPanel.jsx:1-22`, `frontend/src/components/chat/ChatArtifactPanel.jsx:275-410`). Frontend permission checks only select UI routes; backend middleware remains authoritative (`frontend/src/config/router.jsx:99-110`, `backend/internal/api/routes/routes.go:30-44`).

State uses Context for auth/theme/notifications, TanStack Query for server state, and some hooks; API interceptors refresh tokens (`frontend/src/App.jsx:9-27`, `frontend/src/config/axios.js:1-140`). A WebSocket base URL is configured, but execution pages deliberately show persisted logs and no `new WebSocket` runtime call was found using search terms `new WebSocket`, `useWebSocket`, `wsBaseUrl` (`frontend/src/config/app.js:1-10`, `frontend/src/pages/executions/ExecutionLogsPage.jsx:22-36`).

Build, lint, and 22 suites/43 tests pass (`docs/audit/2026-08-19/EVIDENCE/build_frontend.txt:1-80`, `docs/audit/2026-08-19/EVIDENCE/test_frontend.txt:1-10`, `docs/audit/2026-08-19/EVIDENCE/lint.txt:1-4`). There is no browser E2E configuration in `package.json`; Jest is the only test script (`frontend/package.json:6-10`).
