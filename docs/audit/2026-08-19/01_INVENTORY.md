# Inventory

The audit scope is `low-code-workflow-engine`; sibling workspace projects such as `bridge/ERPBridge` are external and were not audited. The repository root contains backend, frontend, datasets, documentation, demo artifacts, scripts, and CI configuration (`README.md:1-17`, `backend/cmd/server/main.go:31-40`, `frontend/src/main.jsx:1-18`). The depth-five raw tree is in [EVIDENCE/file_tree.txt](EVIDENCE/file_tree.txt).

## Languages, frameworks, versions

| Area | Actual manifest evidence |
|---|---|
| Backend | Go 1.22; Fiber 2.52.6; pgx 5.7.2; yaml.v3 3.0.1; JWT v5.2.1 (`backend/go.mod:1-18`). |
| Frontend | React 19.2.0, Vite 7.2.4 range (installed build reports 7.3.6), React Router 7.9.5, TanStack Query 5.90.8, Zustand 5.0.8, React Flow packages 11/12 (`frontend/package.json:1-41`, `docs/audit/2026-08-19/EVIDENCE/build_frontend.txt:1-8`). |
| Semantic service | Python FastAPI/Uvicorn, FAISS CPU, sentence-transformers, NumPy, HTTPX (`backend/semantic_search_service/requirements.txt:1-5`). |

## Entry points

- Go HTTP server: `main`, loads config/registries/storage, constructs validator/runner/tools, and listens (`backend/cmd/server/main.go:31-40`, `backend/cmd/server/main.go:138-173`, `backend/cmd/server/main.go:204-233`).
- Mock ERP demo server: separate `cmd/mock-erp` binary; it refuses production (`backend/cmd/mock-erp/main.go:15-39`).
- Dataset generator and experiment CLI: `cmd/generate-eval-dataset` and `cmd/run-experiment` (`backend/cmd/generate-eval-dataset/main.go:1-22`, `backend/cmd/run-experiment/main.go:1-56`).
- Semantic search: FastAPI application (`backend/semantic_search_service/app.py:1-42`).
- Frontend: React DOM root and BrowserRouter (`frontend/src/main.jsx:1-18`, `frontend/src/config/router.jsx:177-202`).
- Demo PowerShell launcher (`scripts/start-mock-demo.ps1:1-45`).

## Dependencies

Go dependencies are exact versions in `go.mod`/`go.sum`; frontend direct dependencies use caret ranges but `package-lock.json` pins the installed graph (`backend/go.mod:5-48`, `frontend/package.json:11-41`, `frontend/package-lock.json:1-25`). No dependency-usage analyzer was installed or run; `UNDETERMINED` dependencies are therefore not labeled unused solely from names. Source confirms both React Flow packages remain referenced by source/test configuration (`frontend/package.json:17-25`, `frontend/src/tests/__mocks__/reactflow.js:1-7`).

## Environment variables

The backend reads: `APP_ENV`, `APP_NAME`, `APP_HOST`, `APP_PORT`, `API_BASE_PATH`, `FRONTEND_URL`, `JWT_SECRET`, `JWT_EXPIRES_MINUTES`, `ALLOW_PUBLIC_REGISTRATION`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, `DATABASE_URL`, `REDIS_URL`, `STORAGE_DRIVER`, `STORAGE_ENCRYPTION_KEY`, `DATASET_ROOT`, registry/seed paths, Ollama/Gemini/provider settings, MCP URL/mode/timeout, semantic-search settings, chat settings, and `EXPERIMENT_BASELINE` (`backend/internal/config/config.go:79-160`). The mock ERP additionally reads failure and latency controls (`backend/cmd/mock-erp/main.go:57-81`). The frontend reads `VITE_APP_NAME`, `VITE_API_BASE_URL`, `VITE_WS_BASE_URL`, `VITE_ANALYTICS_ENABLED`, and `VITE_SENTRY_DSN` (`frontend/src/config/app.js:1-10`, `frontend/src/config/sentry.js:1-7`).

Real `.env` files exist under backend and frontend. Only variable names were inspected; values were not copied. In the audit process environment these project variables were `UNDETERMINED` because the sandbox process is not the deployment process. Secret values are `[REDACTED]` by policy; config defaults show that memory storage, remote MCP mode with an empty base URL, external semantic search, and Gemini generation are the development defaults (`backend/internal/config/config.go:127-160`).

## Startup behavior

Backend build is IMPLEMENTED and passes. Starting requires runtime registries and a bootstrap administrator for an empty user store; external generation/search/MCP calls additionally require their configured services (`backend/cmd/server/main.go:60-70`, `backend/cmd/server/main.go:101-113`, `backend/cmd/server/main.go:138-173`). Remote MCP without a URL fails closed at execution rather than simulating (`backend/internal/tools/mcp_client.go:60-67`). Frontend build is IMPLEMENTED and passes; it expects the API base and optional WebSocket base from Vite configuration (`frontend/src/config/app.js:1-10`). The semantic service was not started because its Python/Ollama/FAISS runtime was not required by the safe build/test commands; startup status is `UNDETERMINED` (`backend/semantic_search_service/README.md:1-53`).
