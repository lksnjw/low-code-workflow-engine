# Status Codes and Error Handling

Scope: all 118 indexed pairs. The table groups pairs only when their backend status profile and frontend handling are equivalent. Every indexed row appears in a group.

Common backend statuses used below:

- Every protected pair can return `401` for a missing/invalid access token and `403` for an inactive user or missing permission (`backend/internal/api/middlewares/auth.go:13-44`, `backend/internal/api/handlers/handler.go:119-131`, `backend/internal/api/middlewares/rbac.go:8-30`).
- Every mutating pair can return retryable `503` when durable persistence is unavailable (`backend/internal/api/middlewares/persistence.go:13-53`).
- Malformed bodies generally return `400`; missing resources return `404`; uniqueness/concurrency conflicts return `409`; semantic/business validation returns `422`.

## 4.1 Status-code coverage by indexed pair

| Pair(s) | Backend statuses on explicit code paths | Frontend distinction |
|---|---|---|
| 1-9 | `200`; protected `401/403` | Analytics/audit query screens use the generic load error; status and backend message are not distinguished. |
| 10 | `200`, `400`, `401`, `403`, `429`, `500`, `503` | Login surfaces the backend `message`; it does not label status numbers separately. |
| 11 | `201`, `400`, `403`, `409`, `429`, `500`, `503` | Registration surfaces the backend `message`; client-side password checks are distinct. |
| 12 | `200`, `401`, `403` | `401` is refreshed once. A terminal refresh failure expires the session; `403` from an inactive account is not handled (finding E4). |
| 13, 20 | `200`, `400`, `401`, `429`, `500`, `503` | These are non-refreshable. The interceptor's shared refresh path clears the session after a definitive refresh failure; direct `authService.refresh` passes the rejection to its caller. |
| 14-16 | `501` (and limiter `429`) | Row 14 displays the backend message. Rows 15-16 have no shipped page consumer. The operations can never succeed (finding E1). |
| 17 | `200`, protected `401/403`, `503` | All failures are deliberately swallowed and local credentials are deleted (finding E3). |
| 18 | `501` | No shipped page consumer; the operation can never succeed (finding E1). |
| 19 | protected `401/403`, `501`, `503` | No shipped page consumer; the operation can never succeed (finding E1). |
| 21 | `200`, protected `401/403`, `503` | Builder palette uses the backend message; other query screens use a generic load error. |
| 22-27 | `200/201`, `400`, protected `401/403`, `404`, `502`, `503` | Message-send errors are displayed. Create/rename/delete session rejections are not surfaced (finding E7). |
| 28-38 | `200/201`, `400`, protected `401/403`, `404`, `409`, `422`, `503` | Company mutations surface the backend message and structured `fieldErrors`; conflicts and validation are therefore useful even without a status-specific label. |
| 39-42 | `200`, protected `401/403` | Dashboard query failure is generic and loses the backend message (finding E6). |
| 43-49 | `200`, `400`, protected `401/403`, `404`, `422`, `500`, `503` | List/detail loads are generic. Run/retry show the top-level message, but do not correctly expose structured gate evidence (findings E2 and E2b). |
| 50-54 | `200/201`, `400`, protected `401/403`, `404`, `502`, `503` | The currently shipped settings screen only consumes list results; list errors are generic. Service-only mutations have no page-level status handler. |
| 55-57 | `200`, protected `401/403`, `404`, `503` | Notification query errors are not shown in the top bar; mutation errors have no current page consumer. |
| 58-59 | `200`, `400`, protected `401/403`, `503` | Profile load failure is generic; update renders a generic retry sentence rather than the backend message. |
| 60-71 | `200/201`, `400`, protected `401/403`, `404`, `409`, `422`, `503` | Registry create/update surface top-level messages; bulk import additionally reads structured rejected-entry data. Import analysis intentionally substitutes a generic format error. |
| 72-74 | `200`, protected `401/403`, `502/503` | Data-feed loads are generic; rebuild surfaces the backend message. All `5xx` responses also trigger the inaccurate unreachable banner (finding E5). |
| 75-85 | `200/201`, `400`, protected `401/403`, `404`, `409`, `422`, `502`, `503` | Settings loads are generic. Webhook/provider mutations surface backend messages; provider connection failure can also be a successful `200` with `{ok:false}`, which the Models page handles distinctly. |
| 86-87 | `200`, `400`, protected `401/403`, `502/503` | Semantic-search page reduces any rejection to a generic failed state; synthesis has no shipped page consumer. |
| 88 | `201`, `400`, protected `401/403`, `503` | Service has no shipped page consumer, so no visible status distinction exists. |
| 89-102 | `200/201`, `400`, protected `401/403`, `404`, `409`, `503` | Administration mutations surface backend messages and role deletion reads `meta.holders`; collection load failures are generic. |
| 103-117 | `200/201`, `400`, protected `401/403`, `404`, `409`, `422`, `500`, `503` | Workflow mutations generally surface top-level messages. Structured validation details, including failed rule IDs, are not rendered on create/update/publish/run rejection (E2). |
| 118 | `200`, `503` | The top bar suppresses the environment badge on failure; any `503` also activates the global “server unreachable” state (E5). |

## 4.2 Error-envelope comparison

The envelope itself matches. Both explicit failures and Fiber errors return `{success:false,data,message,meta}` (`backend/internal/models/api.go:5-9,25-35`, `backend/cmd/server/main.go:206-218`), and the frontend helper reads `error.response.data.message` (`frontend/src/services/api.js:9-11`). There is no `{error:{...}}` versus top-level `message` mismatch.

Structured detail is not handled consistently:

| ID | Pair(s) | Severity | Finding | Evidence |
|---|---:|---|---|---|
| E2 | 48, 115 | **DEGRADES** | A full-gate `422` places the validation result in `meta`, including `errors` and `failed_rules`. The run UI reads only the top-level “Workflow failed full registry validation before execution” message, so the user does **not** see the rejecting rule ID or validator message. | Frontend: `frontend/src/services/api.js:9-11`, `frontend/src/components/workflows/WorkflowActions.jsx:40-48`, `frontend/src/components/canvas/WorkflowBuilderCanvas.jsx:423-439`. Backend: `backend/internal/api/handlers/execute_mode_production.go:11-12`, `backend/internal/core/validator/registry_validator.go:24-44,619-625`. |
| E2b | 48, 115 | **DEGRADES** | A dispatch-time policy failure stores `failure.ruleId` and `failure.ruleMessage` on the execution, but the `422` response returns only `executionId` and `status` in `meta`. The top-level technical failure string can contain a rule ID, but the authoritative validator message is omitted and the frontend does not fetch the stored execution after rejection. | Frontend: `frontend/src/components/workflows/WorkflowActions.jsx:40-48`. Backend: `backend/internal/api/handlers/execute_handler.go:175-183,238-263`, `backend/internal/models/state.go:28-35`. |

## 4.3 Auth lifecycle

The normal lifecycle is compatible:

- The frontend attaches `Authorization: Bearer <access token>` and the backend parses that exact header/format (`frontend/src/config/axios.js:47-54`; `backend/internal/api/middlewares/auth.go:13-31`).
- A protected `401` starts one shared refresh, persists the rotated refresh token, and retries the original request once (`frontend/src/config/axios.js:63-93,114-138`); the backend invalidates the old refresh digest and returns a new token pair (`backend/internal/api/handlers/auth_handler.go:160-191`).
- A `403` does not trigger refresh, correctly preserving the distinction between unauthenticated and forbidden (`frontend/src/config/axios.js:114-121`; `backend/internal/api/middlewares/rbac.go:8-30`).

Auth findings:

| ID | Pair | Severity | Finding | Evidence |
|---|---:|---|---|---|
| E3 | 17 | **DEGRADES** | Logout is deliberately non-refreshable and swallows every HTTP failure. If the access token has expired, the protected logout handler is never reached, so the backend refresh session is not revoked even though the browser reports a successful local sign-out. | Frontend: `frontend/src/config/axios.js:96-121`, `frontend/src/services/auth.service.js:53-59`. Backend: `backend/internal/api/routes/routes.go:30,46`, `backend/internal/api/handlers/auth_handler.go:147-157`. |
| E4 | 12 | **DEGRADES** | On startup, `/auth/me` can return `403` when the stored user is inactive. The interceptor correctly does not refresh it, but `AuthContext` silently ignores every non-network failure after the request, leaving the cached user authenticated in the UI while protected requests keep failing. | Frontend: `frontend/src/context/AuthContext.jsx:31-58`, `frontend/src/config/axios.js:114-121`. Backend: `backend/internal/api/handlers/handler.go:119-131`, `backend/internal/api/routes/routes.go:30,47`. |
| E5 | all pairs capable of `5xx` | **DEGRADES** | The interceptor classifies every HTTP `5xx` as “server unavailable” and raises an `auth:unreachable` event. The backend deliberately uses `502/503` for reachable, structured states such as persistence rollback or an unavailable semantic dependency, so the global banner falsely says “The server is unreachable.” | Frontend: `frontend/src/config/axios.js:35-45,102-112`, `frontend/src/components/shared/ServerUnreachableBanner.jsx:10-25`. Backend: `backend/internal/api/middlewares/persistence.go:13-53`, `backend/internal/api/handlers/catalog_handler.go:55-85`. |

## 4.4 Stubbed features and swallowed/unhandled errors

| ID | Pair(s) | Severity | Finding | Evidence |
|---|---:|---|---|---|
| E1 | 14-16, 18-19 | **BREAKS** | Password recovery, email verification, OAuth authorization, and two-factor verification are exposed by frontend service methods, and password recovery has a visible page, but every backend handler is an unconditional `501`. The forgot-password page does display the configuration message; the feature still cannot complete. | Frontend: `frontend/src/services/auth.service.js:38-50,61-68`, `frontend/src/pages/auth/ForgotPasswordPage.jsx:12-23`. Backend: `backend/internal/api/handlers/auth_handler.go:202-224`. |
| E6 | query rows noted in 4.1 | **DEGRADES** | Shared query screens pass an `error` object to `ErrorState`, but `ErrorState` does not accept or inspect it. Distinct backend `401`, `403`, and `503` messages collapse to the same generic “requested data is unavailable” text. | Frontend: `frontend/src/components/shared/ResourceState.jsx:7-13`, representative caller `frontend/src/pages/executions/ExecutionListPage.jsx:23-25`. Backend: `backend/internal/api/middlewares/auth.go:23-41`, `backend/internal/api/middlewares/rbac.go:8-30`, `backend/internal/api/middlewares/persistence.go:49-53`. |
| E7 | 23, 25, 26 | **DEGRADES** | Chat session create, rename, and delete handlers await rejecting API promises without a catch or mutation error state. Rename closes immediately and delete/create provide no visible failure feedback. | Frontend: `frontend/src/hooks/useChatSessions.js:12-29`, `frontend/src/components/chat/ChatSessionItem.jsx:9-15,73-79`, `frontend/src/pages/chat/ChatPage.jsx:14-27`. Backend: `backend/internal/api/handlers/chat_handler.go:106-163` (including `400/404` paths), plus protected `401/403` from `backend/internal/api/routes/routes.go:30,123-127`. |

## Step result

- Error envelope: **compatible**.
- Confirmed findings: **8** — BREAKS 1, DEGRADES 7, FRAGILE 0, COSMETIC 0.
- Most important answer: gate rejection details do not reach the run UI in a structured, user-readable form. A pre-execution `422` hides both rule ID and validator message; a dispatch-time `422` omits the stored validator message from the response.
