# Agentic Orchestrator Backend

Enterprise-grade Golang backend for the Low-Code Workflow Automation Engine.

It connects the React frontend to:

- Dataset-backed embedding semantic retrieval over tools, rules, templates, and examples.
- Gemini API workflow YAML candidate generation.
- Multi-candidate YAML generation, registry validation, scoring, and best-candidate selection.
- YAML schema validation and semantic RBAC guardrails.
- A sequential process runner with state variable injection.
- A tool registry inspired by Claude Code's tool architecture.
- An MCP middleware bridge for ERP-safe execution.
- Predictive self-healing when external MCP calls fail.

## Run Locally

```bash
go mod tidy
go run -buildvcs=false ./cmd/server
```

The API starts at:

```text
http://localhost:8080/api
```

Health check:

```text
GET http://localhost:8080/healthz
```

## Chat Orchestration Pipeline

`POST /api/chat/sessions/:id/messages` accepts a natural-language workflow request using either `content` or the older `message` field. The backend calls the embedding semantic search service, retrieves tools/rules/templates/examples, builds a controlled Gemini prompt, generates multiple YAML candidates, validates each candidate against the full registry, and returns the selected valid YAML only when `can_execute=true`.

Useful local configuration:

```env
DATASET_ROOT=./dataset
SEMANTIC_SEARCH_MODE=external_embedding
SEMANTIC_SEARCH_URL=http://localhost:8090/search
SEMANTIC_SEARCH_TOP_K_TOOLS=10
SEMANTIC_SEARCH_TOP_K_RULES=15
SEMANTIC_SEARCH_TOP_K_TEMPLATES=5
SEMANTIC_SEARCH_TOP_K_EXAMPLES=5
SEMANTIC_SEARCH_ALLOW_LEXICAL_FALLBACK=false
INDEX_MAX_TOOLS_PER_FILE=0
INDEX_MAX_RULES_PER_FILE=0
INDEX_MAX_TEMPLATES_PER_FILE=0
INDEX_MAX_EXAMPLES_PER_FILE=25
WORKFLOW_GENERATION_PROVIDER=gemini
GEMINI_MODEL=gemini-2.5-flash
CANDIDATE_COUNT=5
CHAT_TRACE_BOXES=true
```

Full notes are in `docs/CHAT_EMBEDDING_SEARCH_GEMINI_PIPELINE.md`.

## Run Embedding Search Service

```powershell
ollama pull nomic-embed-text
cd semantic_search_service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:DATASET_ROOT="..\dataset"
$env:EMBEDDING_PROVIDER="ollama"
$env:OLLAMA_EMBEDDING_BASE_URL="http://localhost:11434"
$env:OLLAMA_EMBEDDING_MODEL="nomic-embed-text"
$env:INDEX_PROFILE="dev"
$env:INDEX_MAX_ITEMS_PER_FILE="25"
$env:INDEX_MAX_TOOLS_PER_FILE="0"
$env:INDEX_MAX_RULES_PER_FILE="0"
$env:INDEX_MAX_TEMPLATES_PER_FILE="0"
$env:INDEX_MAX_EXAMPLES_PER_FILE="25"
$env:EMBED_BATCH_SIZE="32"
$env:EMBEDDING_TEXT_MAX_CHARS="2000"
$env:REBUILD_SEMANTIC_INDEX="false"
$env:INDEX_INCLUDE_TOOLS="true"
$env:INDEX_INCLUDE_RULES="true"
$env:INDEX_INCLUDE_TEMPLATES="true"
$env:INDEX_INCLUDE_EXAMPLES="true"
$env:INDEX_INCLUDE_VALIDATOR_CASES="false"
uvicorn app:app --host 127.0.0.1 --port 8090
```

Then start the Go backend in another terminal. Gemini is not used for semantic search; Gemini is used only for YAML workflow generation.

The development index loads every tool, rule, and process template. It samples examples at 25 per file so startup stays practical; set `INDEX_MAX_EXAMPLES_PER_FILE=0` when you want every scenario embedded too.

When `CHAT_TRACE_BOXES=true`, every chat generation prints boxed terminal output for retrieved tools/rules, generated candidates, validation results, and the selected YAML.

The first semantic-search startup creates a persistent FAISS/embedding cache under `semantic_search_service/.cache`. Later startups load from cache when the dataset/config fingerprint is unchanged. Check `http://127.0.0.1:8090/index/status`.

## Authentication

All protected API routes require a signed JWT. An empty user store requires
`BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`; startup creates exactly
one Platform Admin through the shared bcrypt path and otherwise refuses to
listen. Once any user exists, bootstrap is skipped and those variables may be
unset.

Later development registrations are controlled by
`ALLOW_PUBLIC_REGISTRATION`, which defaults to `true` outside production, and
always receive the Client role. Production also requires a unique
`JWT_SECRET`, durable PostgreSQL storage, and
`ALLOW_PUBLIC_REGISTRATION=false`. See `../docs/BOOTSTRAP_FLOW.md` for the
restart-safe workflow.

## Implemented API Groups

- `/api/auth`
- `/api/dashboard`
- `/api/workflows`
- `/api/synthesis`
- `/api/chat/sessions`
- `/api/executions`
- `/api/analytics`
- `/api/users`
- `/api/roles`
- `/api/permissions`
- `/api/audit`
- `/api/profile`
- `/api/settings`
- `/api/integrations`
- `/api/notifications`
- `/api/upload`
- `/ws/*`

## Architecture

```text
cmd/server/main.go
  -> Fiber server, CORS, logger, routes

internal/api
  -> HTTP handlers, route aggregation, auth/RBAC/logger middleware

internal/core/synthesizer
  -> strict Gemini prompt generation and candidate parsing

internal/core/validator
  -> YAML schema validation and semantic policy gate

internal/core/runner
  -> sequential execution loop and state manager

internal/core/healing
  -> LLM repair loop for failed MCP executions

internal/tools
  -> Tool interface, registry, MCP bridge, ERP tool implementations

internal/repository + internal/storage
  -> memory runtime store or encrypted PostgreSQL-backed durable state

pkg/parser
  -> YAML parse/stringify/checksum and `{{variable}}` injection
```

## Storage

`STORAGE_DRIVER=memory` is the zero-dependency development default; production configuration requires `postgres`. PostgreSQL mode enables numbered migrations, a lifetime single-writer advisory lock, encrypted restart persistence, active health probing, and durable users, auth sessions, workflow assignments, executions, chats, settings, providers, audit evidence, and uploads. It requires a unique 32-byte `STORAGE_ENCRYPTION_KEY`; database URLs and secrets are never logged. A failed synchronous snapshot is rolled back in memory and its mutating HTTP request returns `503`.

See `../docs/BOOTSTRAP_FLOW.md` for setup, restart verification, cutover rules, recovery guidance, tests, and the current single-writer scaling boundary.

## Remaining Production Swap Points

- `internal/repository`: replace the encrypted snapshot bridge with normalized repositories for multi-writer or high-volume deployments.
- `internal/config/redis.go`: real Redis policy cache.
- `internal/tools/mcp_client.go`: set `MCP_BASE_URL` to Dharmasiri's middleware.
- `semantic_search_service`: replace in-memory FAISS with a persistent vector index if needed.
