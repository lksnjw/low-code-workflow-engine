# Thesis defensibility

## Headline claims

| Claim | Verdict | Code evidence |
|---|---|---|
| A deterministic gate mediates every LLM-plan-to-tool path | Not supported | Normal chat and run paths are gated, but the server-wired Baseline B path executes rejected plans (`backend/internal/core/orchestrator/chat_orchestrator.go:116-200`, `backend/internal/api/handlers/gate_invariant_test.go:215-237`, `backend/cmd/server/main.go:170-173`). |
| Resolved values cannot bypass plan validation | Partly supported | Threshold/required/sensitive deferred checks run at dispatch, but SOD and other rule families do not (`backend/internal/core/validator/registry_validator.go:402-500`). |
| Side effects are retry-safe | Not supported | No backend idempotency field reaches MCP and retry simply launches a new run (`backend/internal/tools/mcp_client.go:69-83`, `backend/internal/api/handlers/execute_handler.go:457-469`). |
| High-risk actions require independent human approval | Not supported | Approval is satisfied by an approval-like action name; no pause/approval execution state exists (`backend/internal/core/validator/registry_validator.go:353-375`, `backend/internal/core/validator/registry_validator.go:898-905`, `backend/internal/api/routes/routes.go:130-136`). |
| Every decision is reproducibly and durably evidenced | Not supported | Gate records omit policy/model versions and default storage is memory (`backend/internal/core/validator/registry_validator.go:1042-1065`, `backend/internal/config/config.go:127-130`). |

## Ten hard panel questions

1. **Can any configuration execute what the gate blocks?** Yes: Baseline B is admitted by `APP_ENV=experiment` and its test proves a tool call (`backend/internal/config/config.go:196-203`, `backend/internal/api/handlers/gate_invariant_test.go:215-237`). The code cannot support the answer “no.”
2. **Why is experiment mode in the same server binary as real MCP dispatch?** The server wires the mode directly into the real executor/registry (`backend/cmd/server/main.go:152-173`). No build separation or no-op tool restriction exists.
3. **Where is the human approval record?** There is none in execution models/routes; only company approval-tier configuration and action-name recognition exist (`backend/internal/models/state.go:36-79`, `backend/internal/api/routes/routes.go:62-65`, `backend/internal/core/validator/registry_validator.go:898-905`).
4. **How are duplicate purchase orders prevented after timeout/retry?** They are not; request and MCP contracts carry no enforced idempotency key (`backend/internal/api/handlers/execute_handler.go:457-469`, `backend/internal/tools/mcp_client.go:69-83`).
5. **Are all templated values fully revalidated?** No; only deferred threshold/required rules and a sensitive scan run (`backend/internal/core/validator/registry_validator.go:402-500`).
6. **Can backend code call MCP without the gate?** Yes, via exported `MCPClient.Execute`/`Tool.Execute` APIs (`backend/internal/tools/tool_interface.go:5-9`, `backend/internal/tools/mcp_client.go:60-101`).
7. **Can an audit record prove the model/prompt/policy used?** No; those fields are not in gate audit evidence (`backend/internal/core/validator/registry_validator.go:1042-1065`).
8. **Is audit evidence immutable and restart-safe?** Only optional PostgreSQL snapshot mode is restart-safe; the blob and contained map records are replaceable (`backend/internal/storage/storage.go:19-29`, `backend/internal/storage/postgres.go:97-113`).
9. **Do evaluation results include known false negatives?** Yes: six self-approval probes are explicitly expected false negatives when SOD is unconfigured (`backend/dataset/eval/generator.go:58-69`, `backend/dataset/eval/experiment.go:28-36`).
10. **What proves real ERP integration?** Only the HTTP MCP adapter and mock/integration tests; live external compatibility is `UNDETERMINED` because response schemas/version negotiation are absent (`backend/internal/tools/mcp_client.go:60-101`, `backend/cmd/mock-erp/service_test.go:60-184`).

## Live demonstration boundary

Today the student can reliably demonstrate local authentication/RBAC, workflow CRUD, LLM or fixture candidate generation when its provider is available, deterministic plan validation, signed-token enforcement, dispatch-time threshold blocking, mock ERP execution, audit capture, and frontend rendering (`backend/internal/api/handlers/gate_invariant_test.go:44-213`, `backend/tests/integration/demo_flow_test.go:20-136`, `frontend/src/config/router.jsx:52-89`). The student cannot honestly demonstrate unbypassable mediation, durable independent approval, idempotent real ERP effects, immutable provenance, or universal real-bridge compatibility (`backend/internal/api/handlers/gate_invariant_test.go:215-237`, `backend/internal/tools/mcp_client.go:60-101`).

The smallest defensible change set is to remove Baseline B from the server binary, make the MCP client require an unforgeable validated-dispatch capability, implement a durable approval state machine with a separate approver, propagate and enforce idempotency keys, replay every applicable resolved-value rule, and persist complete immutable provenance (`backend/cmd/server/main.go:170-173`, `backend/internal/core/runner/executor.go:135-171`, `backend/internal/core/validator/registry_validator.go:1042-1065`).

