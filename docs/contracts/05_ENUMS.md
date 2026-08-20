# Enum and Status Value Diff

The comparison uses values actually emitted or accepted on the wire. “Unknown to FE” means a backend value with no frontend vocabulary entry; frontend-only values are called out explicitly in the notes.

| Family | Backend values | Frontend values expected | Missing in FE | Unknown to FE | Case match? |
|---|---|---|---|---|---|
| Execution status | `PENDING`, `RUNNING`, `DONE`, `FAILED`, `HEALING` | Same five values | None | None | Yes |
| Step status | `RUNNING`, `DONE`, `FAILED` in recorded timeline entries | Same values; governance failure is presented as derived label `BLOCKED` | None | None | Yes |
| Workflow status | `PENDING`, `DONE`, `draft-unvalidated` on normal lifecycle paths. The shared status constants also define `RUNNING`, `FAILED`, `HEALING`. | All six shared values are present in `WORKFLOW_STATUS`/`STATUS_META`; list filters intentionally offer the three normal workflow lifecycle values. | None | None | Yes |
| Risk level | `low`, `medium`, `high`, `critical` in the active registry | Same four lower-case values | None | None | Yes |
| Node type | Backend preview canvas emits `trigger` and `action`; persisted `WorkflowNode.type` is otherwise an unconstrained string. | Read-only `FlowCanvas` accepts/displays any type. Interactive builder uses local ReactFlow type `erpTool`, not a backend response enum. | None | None (open vocabulary) | N/A; current emitted values are preserved verbatim |
| Validation outcome | `valid: boolean` for YAML validation; `passed: boolean` for full-gate validation; chat adds `can_execute: boolean` and numeric passed/blocked counts. | Boolean truth tests and numeric `passed_candidates`/`blocked_candidates`; no competing string enum. | None | None | N/A (booleans) |
| User role | Built-ins: IDs `role_admin`, `role_system_admin`, `role_builder`, `role_client`; names `Platform Admin`, `System Admin`, `Workflow Builder`, `Client`. Custom role IDs/names are allowed. | Same four built-in IDs where special behaviour is required; role lists/names otherwise come from the backend dynamically. | None | None (custom roles fall through dynamically) | Yes |
| Permission names | `workflow:read`, `workflow:write`, `workflow:run`, `workflow_view_all`, `chat:use`, `workflow:read_own`, `workflow:run_own`, `execution:read_own`, `settings:manage`, `provider:manage`, `registry:read`, `registry:write`, `user:manage`, `audit:read` | Routing/navigation collectively uses all backend names. The `PERMISSIONS` constants object contains only nine of them and additionally declares nonexistent `execution:read`. | None in effective routing/navigation; five missing from the constants object | None in effective routing/navigation | Yes for values actually used |

## Evidence by family

- Execution/workflow and failure values: backend `backend/internal/models/workflow.go:8-16`, `backend/internal/models/state.go:15-22`; frontend `frontend/src/constants/workflowStatus.js:1-8,43-51`.
- Step statuses: backend `backend/internal/core/runner/executor.go:78-109,118-162`; frontend `frontend/src/components/executions/ExecutionTimeline.jsx:5-25`.
- Risk values: backend `backend/configs/registries/all_tools_master_registry.json:17,92,317,392`; frontend `frontend/src/components/chat/ChatArtifactPanel.jsx:7-13`.
- Node types: backend `backend/internal/api/handlers/workflow_handler.go:610-618`, `backend/internal/models/workflow.go:96-104`; frontend `frontend/src/components/canvas/FlowCanvas.jsx:4-5`, `frontend/src/components/canvas/WorkflowBuilderCanvas.jsx:296-301,343-365`.
- Validation outcomes: backend `backend/internal/models/api.go:101-111`, `backend/internal/core/validator/registry_validator.go:24-40`, `backend/internal/core/orchestrator/orchestration_models.go:29-44`; frontend `frontend/src/components/chat/ChatArtifactPanel.jsx:273-331`.
- Roles and permissions: backend `backend/internal/repository/memory.go:14-18,64-79,113-128`; frontend `frontend/src/constants/permissions.js:1-12`, `frontend/src/config/router.jsx:54-87`, `frontend/src/components/users/RolePermissionEditor.jsx:10`.

## Fallback behaviour

| Family | Unknown-value rendering | Assessment |
|---|---|---|
| Execution/workflow status | `statusMetaFor` and `WorkflowBadge` map every unknown value to the `PENDING` label and styling; the execution icon also falls back to pending. | **Not sensible**: it conceals the actual value and mislabels an unknown terminal/error state as pending. Finding V1. |
| Step status | Timeline prints the raw value in the step text. | Sensible transparent fallback. |
| Risk level | `Pill` receives the raw risk text and falls back to neutral gray styling. | Sensible; label remains visible. |
| Node type | `FlowCanvas` prints the raw type and uses a default icon if needed. | Sensible. |
| Validation outcome | Boolean; no unknown string state. Missing summary counts fall back to `0`. | Sensible for the current contract. |
| User role | Backend-provided name is rendered. Unknown/custom role IDs receive no special built-in treatment, while permission checks remain authoritative. | Sensible. |
| Permission name | Unknown permissions simply fail exact membership checks. | Safe-deny, but the duplicate/inconsistent frontend vocabulary is fragile (V2). |

## Findings

| ID | Severity | Mismatch | User-visible symptom | Evidence |
|---|---|---|---|---|
| V1 | **FRAGILE** | Current backend execution/workflow statuses all match, but the frontend fallback converts any new or misspelled backend status into `PENDING` rather than preserving an unknown label. | A plausible future status such as `CANCELLED` would appear as “Pending,” potentially hiding a terminal outcome. | Frontend: `frontend/src/constants/workflowStatus.js:10-41,66-68`, `frontend/src/components/executions/ExecutionStatus.jsx:12-24`, `frontend/src/components/workflows/WorkflowBadge.jsx:3-6`. Backend: current closed values at `backend/internal/models/workflow.go:8-16`. |
| V2 | **FRAGILE** | The frontend permission constants are not the backend vocabulary: they omit five real permissions and add `execution:read`, which the backend never defines. Current routing works only because it duplicates the correct names as string literals elsewhere. | No current screen is broken, but a component using `PERMISSIONS.EXECUTION_READ` would deny/hide execution access for every user, and the constants cannot express own-scope/chat/default-list permissions. | Frontend: `frontend/src/constants/permissions.js:1-12`, contrasted with correct literals in `frontend/src/config/router.jsx:57-87`. Backend: `backend/internal/repository/memory.go:64-79`, `backend/internal/api/routes/routes.go:31-44`. |

## Step result

- Required enum families checked: **8**.
- Current backend values missing from effective frontend handling: **0**.
- Frontend-only wire value: **1 dormant constant** (`execution:read`).
- Findings: **2 FRAGILE**.
