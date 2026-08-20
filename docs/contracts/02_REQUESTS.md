# Request Contract Diff

Scope: all 118 frontend/backend pairs indexed in `01_PAIRING.md`. Each pair was checked for every applicable request facet: JSON or multipart body, path variables, query parameters, authentication header, and content type. This document lists mismatches only.

## Findings

| Pair | Severity | Frontend sends | Backend reads | Contract mismatch | Evidence |
|---:|---|---|---|---|---|
| 115 | **DEGRADES** | `workflowService.run` conditionally serializes `idempotencyKey` in the run body. | `RunWorkflow` parses the field into `RunWorkflowRequest`, but the execution path uses `DryRun` and `Input` only; it never checks, stores, or deduplicates on `IdempotencyKey`. | The key is accepted and silently ignored. A caller can reasonably believe a repeated run is idempotent when it can instead create another execution. The earlier audit finding is therefore still true. | Frontend: `frontend/src/services/workflow.service.js:62-68`. Backend: `backend/internal/models/state.go:90-95`, `backend/internal/api/handlers/execute_handler.go:21-75`. |
| 27 | **DEGRADES** | `chatService.sendMessage` conditionally includes `workflowId` alongside `content`, `mode`, and `model`. | `SendChatMessage` reads `content`/`message`, `model`, `mode`, candidate count, and the four `top_k_*` fields; it never reads `workflowId`. | A supplied workflow context is silently discarded. The currently shipped `ChatPage` forwards only `model` and `mode`, so this is a dormant service-contract defect rather than a presently exercised page flow. | Frontend: `frontend/src/services/chat.service.js:29-34`, `frontend/src/pages/chat/ChatPage.jsx:29-40`. Backend: `backend/internal/api/handlers/chat_handler.go:167-226`. |

## Coverage result

- Indexed pairs checked: **118**.
- Request-contract mismatches: **2**.
- Request-contract-clean pairs: **116**.
- Missing backend-required fields: **0 confirmed**.
- Path/query naming, ordering, and encoding mismatches: **0 confirmed**.
- Authentication/content-type mismatches: **0 confirmed**. The shared client sends `Authorization: Bearer <token>` and JSON by default (`frontend/src/config/axios.js:4-10,47-54`), matching the backend bearer parser (`backend/internal/api/middlewares/auth.go:15-16`); the upload caller uses multipart form data with field `file` (`frontend/src/services/upload.service.js:4-8`), matching `FormFile("file")` (`backend/internal/api/handlers/notification_handler.go:61-64`).

## Idempotency conclusion

**Confirmed:** the frontend exposes and sends an idempotency key, the backend deserializes it, and no backend execution logic consumes it. This is not a field-name or casing error; it is a semantic request-contract mismatch.
