# Role Portals Implementation Result

## Status

All five requested vertical slices are implemented on `feat/role-portals`. Backend authorization remains authoritative; frontend permission checks only control navigation and presentation. The validator rules, runner dispatch/revalidation, healing logic, semantic-search internals, and auth token mechanics were not changed.

## What Works by Role

| Capability | Platform Admin / `workflow:write` role | Client (`role_client`) |
|---|---|---|
| Navigation | Existing full portal plus Registry and Models | Chat, My Workflows, My Executions, Profile |
| Direct forbidden route | Allowed when the required permission is present | Access Denied screen; protected page is not rendered |
| Registry | View/add/edit tools and rules; persist JSON; rebuild suggestion | No access; backend returns 403 |
| Model providers | Add/edit/test/activate Gemini, Ollama, or OpenAI-compatible configs | No access; backend returns 403 |
| Workflows | Create, edit, publish, export, run, and assign users | See and run only owned or assigned workflows |
| Canvas | Full drag/connect/deploy/run builder | Read-only workflow preview with visible nodes |
| Executions | Existing broad access | Only executions started by that client, including details/logs |
| Chat | Existing experience | Existing experience, but sessions are owner-scoped and builder affordances are hidden |
| Users, roles, analytics, audit, settings, datafeed | Existing permission-controlled access | Hidden and forbidden |

The first account registered into an empty in-memory store becomes `role_admin`. Every later public registration becomes `role_client` with only `chat:use`, `workflow:read_own`, `workflow:run_own`, and `execution:read_own`.

## Panel Demo Script

### 1. Start the application

From `backend`:

```powershell
go run -buildvcs=false ./cmd/server
```

From `frontend` in a second terminal:

```powershell
npm.cmd run dev
```

Open `http://127.0.0.1:5173`. The frontend defaults to `http://localhost:8080/api` for API calls.

For live chat generation, also start the documented semantic-search service on port 8090 and make either an active provider config or the existing environment fallback available. Ordinary RBAC, registry, workflow, assignment, and execution demonstrations do not require changing auth mechanics.

### 2. Bootstrap and inspect the admin portal

1. Start with a fresh backend process and register the first account.
2. Sign in as that account and show the complete admin navigation.
3. Open **Models**, add one of the three supported provider types, enter its key only in the write-only field, and save it.
4. Confirm that the list shows only a masked `keyPreview`, then use **Test Connection** and **Activate**.
5. Open **Registry**, switch between Tools and Rules, and view an existing record.
6. Add or edit valid JSON. Show the successful mutation and the semantic rebuild suggestion.
7. Use the rebuild action if the semantic service is running. Registry mutation itself never silently starts a rebuild.

### 3. Create the client and assign work

1. In a private browser window, register a second account. It receives the Client role automatically.
2. Return to the admin session and create or open a validated workflow.
3. On workflow detail, use **Assign users** to assign the client.
4. If the workflow will be executed in the demo, confirm that every referenced registry tool includes `Client` in `allowed_roles`. This preserves the validator's existing role gate.
5. Show that the admin retains edit, export, builder, assignment, and run controls.

### 4. Demonstrate the client portal

1. Sign in as the second account.
2. Show that navigation contains only Chat, My Workflows, My Executions, and Profile.
3. Open **My Workflows**. Only owned or assigned workflows are returned by the API.
4. Open the assigned workflow. Show the **Run** action and read-only canvas preview.
5. Confirm that new/edit/deploy/publish/export/assignment controls and Chat's **Pass to Canvas** action are absent.
6. Run the assigned workflow, then open **My Executions** and its detail/log view.
7. Attempt a forbidden route or another user's workflow URL. The UI shows Access Denied where applicable, while the API independently returns 403/404 and does not disclose the resource.

### 5. Demonstrate change safety

1. Validate a workflow or otherwise obtain a validation token.
2. As admin, mutate a registry tool or rule.
3. The JSON file is replaced safely, the in-memory snapshot and SHA-256 registry hash change together, and an audit entry records actor, target, old hash, and new hash.
4. Attempting to use the old token is rejected because it is bound to the old registry hash.

## Slice Results and Files Changed

### Slice 1 — Client role and frontend gating

Commit: `b12decee9e5a57030ff7c926c21cc3ff63757fe7`

- `backend/internal/api/handlers/auth_handler.go` — preserves first-user admin bootstrap and defaults later registrations to Client.
- `backend/internal/api/handlers/auth_handler_test.go` — proves the post-bootstrap registration role.
- `backend/internal/repository/memory.go` — seeds the Client role and own-scope permissions.
- `frontend/src/App.jsx` — adds route permission metadata and protected-page handling.
- `frontend/src/components/navigation/MobileNav.jsx` — filters mobile navigation by real permissions.
- `frontend/src/components/navigation/Sidebar.jsx` — filters desktop navigation by real permissions.
- `frontend/src/constants/navigation.js` — declares permission-gated entries and the client-visible labels.
- `frontend/src/constants/navigation.test.js` — proves admin/client navigation visibility.
- `frontend/src/hooks/usePermissions.js` — derives `has`, `hasAny`, `role`, and `roleId` from AuthContext.
- `frontend/src/pages/errors/UnauthorizedPage.jsx` — renders the direct-route Access Denied state.
- `frontend/src/utils/permission.utils.js` — contains testable permission and navigation helpers.
- `frontend/src/utils/permission.utils.test.js` — proves forbidden direct activation is rejected.

Verification at the slice boundary: `go build ./...`, `go test ./... -count=1`, `npm run lint`, and `npm test` all exited 0.

### Slice 2 — Runtime registry CRUD and atomic reload

Commit: `0d501a4813565c76c5c5d0e3297a316366639ec8`

- `backend/cmd/server/main.go` — wires the file-backed registry manager into the server.
- `backend/internal/api/handlers/handler.go` — exposes the manager to API handlers.
- `backend/internal/api/handlers/registry_handler.go` — implements strict, gated, audited tool/rule GET, POST, and PUT handlers.
- `backend/internal/api/handlers/registry_handler_test.go` — proves persistence, hash change, old-token rejection, audit creation, malformed rejection, and 403 behavior.
- `backend/internal/api/routes/routes.go` — registers the registry endpoints under `settings:manage`.
- `backend/internal/core/registry/manager.go` — validates unique records, safely replaces JSON, swaps snapshots under locks, and recomputes the hash.
- `backend/internal/core/registry/rule_registry.go` — adds concurrency-safe rule snapshot replacement.
- `backend/internal/core/registry/tool_registry.go` — adds concurrency-safe tool snapshot replacement.
- `frontend/src/App.jsx` — registers the Registry page.
- `frontend/src/constants/navigation.js` — adds the gated Registry navigation item.
- `frontend/src/context/NotificationContext.jsx` — supports an actionable semantic-rebuild notification.
- `frontend/src/pages/registry/RegistryPage.jsx` — provides tool/rule tabs, detail, JSON add/edit, validation feedback, and rebuild action.
- `frontend/src/services/registry.service.js` — calls registry mutation and semantic rebuild endpoints.

Verification at the slice boundary: all four required Go/frontend commands exited 0.

### Slice 3 — Runtime provider configs with write-only keys

Commit: `889873ef275c6f8dc25da851b3500ee5a323e9b5`

- `backend/internal/api/handlers/handler.go` — makes provider resolution available to handlers/synthesis.
- `backend/internal/api/handlers/provider_handler.go` — implements list/create/update/activate/test with sanitized responses and audit records.
- `backend/internal/api/handlers/provider_handler_test.go` — proves key non-disclosure, masking, activation switching, test calls, sanitized audits, and 403 behavior.
- `backend/internal/api/routes/routes.go` — registers provider endpoints under `settings:manage`.
- `backend/internal/core/synthesizer/candidates.go` — resolves the active provider on each synthesis request with environment fallback.
- `backend/internal/core/synthesizer/gemini_client.go` — supports runtime Gemini configuration and sanitized transport errors.
- `backend/internal/core/synthesizer/ollama_client.go` — supports runtime Ollama configuration.
- `backend/internal/core/synthesizer/openai_client.go` — adds the scoped OpenAI-compatible chat-completions client.
- `backend/internal/models/settings.go` — defines `ProviderConfig` with a non-serializable API key and masked view.
- `backend/internal/repository/memory.go` — stores provider configs and resolves the one active config.
- `frontend/src/App.jsx` — registers the Models page.
- `frontend/src/constants/navigation.js` — adds the gated Models navigation item.
- `frontend/src/pages/models/ModelsPage.jsx` — provides list, add/edit, activate, and connection-test UI.
- `frontend/src/pages/settings/SettingsPage.jsx` — links provider management from existing settings.
- `frontend/src/services/settings.service.js` — adds provider API operations without reading keys back.

Verification at the slice boundary: all four required Go/frontend commands exited 0.

### Slice 4 — Backend client scoping and workflow assignment

Commit: `99bec43a12cce96676796db5385cc0933f47288a`

- `backend/internal/api/handlers/chat_handler.go` — assigns chat ownership and scopes session list/get/messages.
- `backend/internal/api/handlers/client_scope_test.go` — proves two-client workflow, execution, log, chat, assignment, and admin isolation behavior.
- `backend/internal/api/handlers/execute_handler.go` — enforces assigned/owned run access and started-by execution access.
- `backend/internal/api/handlers/gate_invariant_test.go` — updates the invariant fixture for explicit admin permissions.
- `backend/internal/api/handlers/scope_helper.go` — centralizes broad-vs-own permission and resource ownership checks.
- `backend/internal/api/handlers/workflow_handler.go` — filters workflow access and implements audited assignment/unassignment plus assignable users.
- `backend/internal/api/middlewares/rbac.go` — adds an any-of permission gate without weakening existing checks.
- `backend/internal/api/routes/routes.go` — allows broad or own permissions on existing handlers and registers assignment endpoints.
- `backend/internal/models/settings.go` — adds chat session `ownerId`.
- `backend/internal/models/workflow.go` — adds workflow `assignedUserIds`.
- `frontend/src/components/workflows/WorkflowActions.jsx` — permits Run through broad or own-run permission.
- `frontend/src/components/workflows/WorkflowAssignments.jsx` — adds the existing-page assignment picker and controls.
- `frontend/src/pages/executions/ExecutionListPage.jsx` — labels the client-scoped list as My Executions.
- `frontend/src/pages/workflows/WorkflowDetailPage.jsx` — adds assignment controls only for writers.
- `frontend/src/pages/workflows/WorkflowListPage.jsx` — labels the scoped list and hides creation for clients.
- `frontend/src/services/user.service.js` — retrieves the minimal assignable-user list.
- `frontend/src/services/workflow.service.js` — adds assign/unassign calls and preserves assignment data.

Verification at the slice boundary: all four required Go/frontend commands exited 0.

### Slice 5 — Role-aware screen modes

Commit: `3d0610521f902c812d66ce175c8506896da09617`

- `frontend/src/components/canvas/BuilderModeControls.js` — renders full builder controls or a read-only badge.
- `frontend/src/components/canvas/WorkflowBuilderCanvas.jsx` — loads existing YAML, shows nodes in embedded preview mode, and disables mutations for read-only users.
- `frontend/src/components/chat/ChatArtifactPanel.jsx` — hides Pass to Canvas without `workflow:write` and starts a clean draft for writers.
- `frontend/src/components/screen_modes.test.js` — server-render tests for hidden canvas and workflow actions.
- `frontend/src/components/workflows/WorkflowActionControls.js` — isolates permission-driven Run/Export rendering for testing.
- `frontend/src/components/workflows/WorkflowActions.jsx` — keeps Run for own-run permission and restricts Export to writers.
- `frontend/src/context/RouteContext.jsx` — adds clean new-workflow navigation while retaining edit selection.
- `frontend/src/pages/workflows/WorkflowBuilderPage.jsx` — passes selected workflow and edit mode into the existing canvas.
- `frontend/src/pages/workflows/WorkflowDetailPage.jsx` — provides writer edit controls or the client's embedded read-only preview.
- `frontend/src/pages/workflows/WorkflowListPage.jsx` — routes New Workflow through clean draft state.

Real final slice output:

```text
go build ./...                         exit 0
go test ./... -count=1                exit 0; all packages passed; tests/unit 103.939s
npm.cmd run lint                      exit 0
npm.cmd test                          6 suites passed; 8 tests passed
npm.cmd run build                     2139 modules transformed; production build passed
```

Vite reports one non-failing warning: the main minified JavaScript chunk is larger than 500 kB. This does not affect portal correctness; route-level code splitting is the appropriate later optimization.

## Security and Invariant Evidence

- Every new mutation route is permission-gated and audit-logged.
- Client list restrictions are applied in backend handlers, not inferred from hidden buttons.
- Provider API key fields use `json:"-"`; responses expose only the first four characters plus masking.
- Provider keys are omitted from audit payloads and transport errors are sanitized.
- Registry entries use strict JSON decoding, required-field checks, and uniqueness checks before becoming active.
- Registry file and in-memory changes are coordinated with rollback behavior, snapshot locking, and hash recomputation.
- Runner acceptance still depends on the pre-existing workflow/registry/token invariants; an old registry-bound token is rejected after mutation.
- No frozen validator, runner, healing, semantic-search, or auth-token logic was modified.

## Deliberate Limits / Resume Points

Nothing from the five requested slices is unfinished. The following constraints are deliberate scope decisions and should be addressed only for production work:

1. Users, workflows, chats, executions, audits, and provider configs remain in memory and reset on backend restart. Resume at `backend/internal/repository` with a durable repository implementation.
2. Registry JSON is durable, but semantic index rebuild remains an explicit admin action. Resume at the existing rebuild integration if automatic orchestration is later approved.
3. Provider secrets are write-only but held in process memory. Resume with a server-side secret manager; do not route secrets through generic settings maps.
4. Client execution still obeys registry `allowed_roles`. Configure demo tools for `Client`; do not weaken validation to bypass this.
5. OAuth, 2FA, password reset, invitations, organizations, tags/entitlements, and additional provider protocols remain intentionally out of scope.
6. The frontend production bundle can later be split by route to remove the non-failing Vite chunk-size warning.

Before sharing or deploying the project, rotate any real credentials kept in ignored local environment files and move deployment secrets to an appropriate secret store.
