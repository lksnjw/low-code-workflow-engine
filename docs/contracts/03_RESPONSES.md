# Response Contract Diff

Scope: all 118 pairs in `01_PAIRING.md`. The common envelope is compatible: the backend emits `{success,data,message,meta}` and list pagination in `meta` (`backend/internal/models/api.go:5-9,38-43`), while the frontend's `unwrap` returns only `data` (`frontend/src/services/api.js:1-7`). The mismatches below occur where a service/page treats that paged `data` array as the complete collection and provides no way to consume `meta` or request another page.

## Findings

| Pair | Severity | Response mismatch | User-visible symptom | Evidence |
|---:|---|---|---|---|
| 103 | **DEGRADES** | `ListWorkflows` defaults to a 20-item page and returns the true `total`/`totalPages` in `meta`; `workflowService.list` discards `meta`, and the workflow page renders only the returned array with no next-page control. | After 20 matching workflows, later workflows are silently absent from both cards and table. Filters cannot reveal results outside the first backend page. | Frontend: `frontend/src/services/workflow.service.js:22-24`, `frontend/src/pages/workflows/WorkflowListPage.jsx:23-24,45-57`. Backend: `backend/internal/api/handlers/workflow_handler.go:18-20,60-66`, `backend/internal/api/handlers/handler.go:231-257`. |
| 43 | **DEGRADES** | `ListExecutions` returns one default 20-item page plus pagination metadata; `executionService.list` retains only the array, and the execution-history page has no pagination consumer. | Execution history silently stops at the first 20 matching runs, hiding older evidence. | Frontend: `frontend/src/services/execution.service.js:15-19`, `frontend/src/pages/executions/ExecutionListPage.jsx:13-26`. Backend: `backend/internal/api/handlers/execute_handler.go:378-404`, `backend/internal/api/handlers/handler.go:231-257`. |
| 89 | **DEGRADES** | `ListUsers` paginates users at 20 by default and returns totals in `meta`; `loadAdministration` drops `meta`, and the directory renders the returned users as the entire directory. | Organisations with more than 20 users cannot see or manage users beyond the first page. | Frontend: `frontend/src/services/user.service.js:7-20`, `frontend/src/pages/users/UserListPage.jsx:20,105-133`. Backend: `backend/internal/api/handlers/admin_handler.go:16-45`, `backend/internal/api/handlers/handler.go:231-257`. |
| 22 | **DEGRADES** | `ListChatSessions` returns a default 20-item page plus `meta`; `chatService.listSessions` reads `response.data.data` only, and the session sidebar renders that array without a load-more or page control. | Conversations after the first 20 disappear from the chat history sidebar. | Frontend: `frontend/src/services/chat.service.js:4-7`, `frontend/src/components/chat/ChatHistory.jsx:38-64`. Backend: `backend/internal/api/handlers/chat_handler.go:91-103`, `backend/internal/api/handlers/handler.go:231-257`. |
| 9, 94 | **DEGRADES** | Both audit callers discard pagination metadata. `userService.loadAudit` explicitly asks for only 10 entries; `auditService.list` receives the backend's default 20. The audit page exposes no pagination control. | The audit trail appears complete but silently omits every event after the first requested page (10 in the shipped page flow). | Frontend: `frontend/src/services/audit.service.js:4-7`, `frontend/src/services/user.service.js:22-25`, `frontend/src/pages/users/AuditPage.jsx:6-20`. Backend: `backend/internal/api/handlers/admin_handler.go:462-468`, `backend/internal/api/handlers/handler.go:231-257`. |
| 55 | **DEGRADES** | Notifications are paginated and capped at 100 per request; the top bar asks for 100 unread items but drops the returned total in `meta` and computes the badge count from array length. | More than 100 unread notifications are reported as 100 (rendered as `99+`) with no indication that additional items exist. | Frontend: `frontend/src/services/notification.service.js:4-7`, `frontend/src/components/navigation/Topbar.jsx:97-108,159-170`. Backend: `backend/internal/api/handlers/notification_handler.go:16-30`, `backend/internal/api/handlers/handler.go:231-257`. |

## Coverage result

- Indexed pairs checked: **118**.
- Response-mismatched pairs: **7** (six findings; the audit finding covers two indexed callers of the same backend response).
- Response-contract-clean pairs: **111**.
- Envelope mismatch outside pagination: **0 confirmed**.
- Confirmed field-name, array/object, nullability, or date-format mismatch outside pagination: **0**. Go `time.Time` values are emitted as RFC 3339 JSON strings and the frontend's date consumers use the JavaScript `Date` parser with guards where display conversion is derived.
- The semantic health/metadata/rebuild proxy responses (pairs 72-74) were also traced through the local Python service rather than guessed: the fields consumed by the data-feed pages are emitted by `backend/semantic_search_service/app.py:174-220` and passed through by `backend/internal/api/handlers/catalog_handler.go:55-85`.

## User-impact summary

All confirmed response defects are silent truncation. No incompatible success envelope was found; the frontend loses the backend's pagination contract after correctly unwrapping `data`.
