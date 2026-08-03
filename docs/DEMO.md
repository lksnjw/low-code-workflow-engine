# Governed End-to-End Demo

This runbook proves the complete local path: environment-provisioned bootstrap administrator and RBAC, a Gemini 2.5 Flash provider, registry-backed workflow construction, assignment to a Client, deterministic execution against the standalone mock ERP, and a policy block before an unsafe tool dispatch.

The demo intentionally does not require Ollama. Gemini generates workflows; it is not the embedding service. The optional research setup at the end runs the Python semantic service with a local Sentence Transformers model.

## Safety defaults

| Setting | Default | Demo value | Meaning |
|---|---|---|---|
| `MCP_MODE` | `remote` | `remote` | The runner uses the normal remote MCP transport for both the standalone mock ERP and a real bridge. |
| `MCP_BASE_URL` | unset | `http://127.0.0.1:9000` | Selects the standalone mock ERP for this demo. Changing only this URL switches to Nimendra's real bridge. |
| `SEMANTIC_FALLBACK` | `off` | `lexical` | Lexical retrieval is opt-in when the external semantic service is unavailable. |
| `EXPERIMENT_BASELINE` | unset | unset | The deterministic validation gate remains enabled. Do not use Baseline B for this demo. |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | unset | set | Required whenever the user store is empty. The server exits with `empty user store requires BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD` if either is missing. The password must be at least 8 characters. |

Neither demo switch weakens schema validation, RBAC, registry validation, policy validation, validation-token checks, or dispatch-time revalidation.

## Prerequisites

- Go 1.22 or newer
- Node.js 20 or newer and npm
- A Gemini API key for the provider connection test and chat generation
- Python 3.10 or newer only if running the optional semantic service

Never paste a real key into source files, JSON registries, workflow YAML, screenshots, or commits. Enter it only in the write-only provider field.

## 1. Start the standalone mock ERP

Open PowerShell in the repository root, then run:

```powershell
cd backend

$env:APP_ENV="development"
$env:MOCK_ERP_PORT="9000"
$env:MOCK_ERP_MIN_LATENCY_MS="80"
$env:MOCK_ERP_MAX_LATENCY_MS="250"
$env:MOCK_ERP_FAIL_TOOL=""
$env:MOCK_ERP_FAIL_MODE=""

go run -buildvcs=false ./cmd/mock-erp
```

The startup line lists every active runtime-registry tool. Verify the service
from another terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:9000/healthz
```

`POST http://127.0.0.1:9000/reset` restores the deterministic fixture state
and clears the service's in-memory request log. For an injected failure, restart
the service after setting one registry tool name and one supported mode:

```powershell
$env:MOCK_ERP_FAIL_TOOL="finance.clear_invoice"
$env:MOCK_ERP_FAIL_MODE="transient" # transient | auth | notfound | invalid
```

## 2. Start the demo backend

Open PowerShell in the repository root, then run:

```powershell
cd backend

$env:APP_ENV="development"
$env:APP_HOST="127.0.0.1"
$env:APP_PORT="8080"
$env:FRONTEND_URL="http://127.0.0.1:5173"
$env:JWT_SECRET="replace-this-local-demo-secret"
$env:ALLOW_PUBLIC_REGISTRATION="true"
$env:BOOTSTRAP_ADMIN_EMAIL="admin@demo.local"
$env:BOOTSTRAP_ADMIN_PASSWORD="replace-this-demo-password"
$env:MCP_MODE="remote"
$env:MCP_BASE_URL="http://127.0.0.1:9000"
$env:SEMANTIC_SEARCH_MODE="external_embedding"
$env:SEMANTIC_SEARCH_URL="http://127.0.0.1:8090/search"
$env:SEMANTIC_FALLBACK="lexical"
$env:WORKFLOW_GENERATION_PROVIDER="gemini"
$env:GEMINI_MODEL="gemini-2.5-flash"
$env:EXPERIMENT_BASELINE=""

go run ./cmd/server
```

Expected health check from a second terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:8080/healthz
```

The response should report `status` as `healthy`.

Do not set `TOOL_REGISTRY_PATH` or `RULE_REGISTRY_PATH` for the demo. The server
requires both to resolve inside `backend/configs/runtime` and refuses to start
otherwise. On first run it seeds that directory from the frozen
`backend/configs/registries` copies, so registry edits made in the UI land in
`configs/runtime` and never touch the frozen evaluation registries.

`SEMANTIC_FALLBACK=lexical` also makes the demo usable while port `8090` is not running.

## 3. Start the frontend

Open another PowerShell terminal in the repository root:

```powershell
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` to the backend on port `8080`.

## 4. Sign in as the bootstrap administrator

Before starting an empty installation, set `BOOTSTRAP_ADMIN_EMAIL` and
`BOOTSTRAP_ADMIN_PASSWORD`. The backend creates exactly one Platform Admin and
refuses to start if either value is missing.

1. Open the sign-in screen.
2. Enter the bootstrap email and password.
3. Click **Sign in**.
4. Confirm that the administration navigation includes **Models**, **Registry**, and **Users**.

If the backend uses the memory store, restarting it creates a new empty
installation, so the environment-provided bootstrap runs again.

## 5. Configure Gemini 2.5 Flash

1. Open **Models** > **Provider Configs**.
2. Click **Add provider**.
3. Enter:
   - Name: `Demo Gemini`
   - Provider type: `Gemini`
   - Base URL: leave blank
   - Model: `gemini-2.5-flash`
   - API key: your real Gemini API key
4. Click **Save provider**. The first provider is activated automatically; otherwise click **Activate**.
5. Click **Test connection** and confirm **Connection successful**.

The API returns only a short credential preview. It never returns the stored key.

## 6. Verify the demo tool and add the policy rule

1. Open **Registry** > **Tools & Rules**.
2. On the **Tools** tab, find **Demo Echo** (`TOOL-DEMO-001`) and click **View**.
3. Verify that its action is `demo.echo`, status is `active_mcp_schema_present`, it is read-only, both `message` and `amount` are required, and **Client** is in `allowed_roles`.
4. Select the **Rules** tab and click **Add rule**.
5. Replace the editor content with the JSON below and click **Validate & save**.

```json
{
  "rule_id": "DEMO-AMOUNT-001",
  "rule_name": "Block unsafe demo amounts",
  "rule_type": "amount_threshold",
  "domain": "demo",
  "description": "Block the demo echo before dispatch when amount exceeds 100.",
  "applies_to_tools": ["demo.echo"],
  "applies_to_roles": [],
  "condition": {
    "type": "numeric_threshold",
    "parameter": "amount",
    "operator": ">",
    "value": 100
  },
  "enforcement_action": "block",
  "severity": "high",
  "validator_message": "Demo amount exceeds the allowed maximum of 100.",
  "llm_prompt_instruction": "Keep demo.echo amount at or below 100.",
  "healing_guidance": "Lower amount to 100 or less.",
  "bpi_alignment": [],
  "audit_fields_required": [],
  "enabled": true
}
```

The registry hash changes when the rule is saved. Previously issued validation tokens are therefore invalidated automatically.

## 7. Create Builder and Client accounts

1. Open **Users** > **Directory**.
2. In **Create User**, create `Demo Builder` with the **Workflow Builder** role and a password of at least eight characters.
3. Create `Demo Client` with the **Client** role and a different email address.

The Client role can read and run only workflows that it owns or that a Builder assigns to it.

## 8. Build and assign the workflow

1. Sign out of the administrator account and sign in as `Demo Builder`.
2. Open **Workflows** > **Flow Builder**.
3. In the `demo` catalog group, drag **Demo Echo** onto the canvas.
4. Click **Deploy Workflow**. The registered schema generates these governed runtime expressions:

```yaml
parameters:
  message: "{{input.message}}"
  amount: "{{input.amount}}"
```

5. Open **Workflows** > **All Workflows**, then open the newly deployed workflow (the default name is **Untitled workflow**).
6. In **Assigned users**, select `Demo Client`.

The threshold cannot be decided while the YAML contains `{{input.amount}}`, so the validator records a deferred check in the signed validation token. The runner evaluates that same rule after resolving the Client's runtime input and before calling MCP.

## 9. Run the safe and unsafe cases as Client

Sign out and sign in as `Demo Client`, then open **My Workflows** and select the assigned workflow.

For the safe case:

1. Click **Run**.
2. In **Runtime input (JSON)** enter:

```json
{
  "message": "hello from the client portal",
  "amount": 10
}
```

3. Click **Run workflow**.
4. Confirm that the execution finishes with status `DONE`.

For the policy-unsafe case:

1. Click **Run** again.
2. Enter:

```json
{
  "message": "this call must never reach the tool",
  "amount": 150
}
```

3. Click **Run workflow**.
4. Confirm that the execution finishes with status `FAILED`.
5. Open **My Executions** > **Run History** and inspect the failed run. Its log identifies `DEMO-AMOUNT-001`; there is no successful `demo.echo executed through tool registry` entry.

This is a dispatch-time policy block. The unsafe MCP call is not made.

## 10. Start all three processes with one command

After configuring `backend/.env`, run:

```powershell
.\scripts\start-mock-demo.ps1
```

The script starts the mock ERP first, waits for its health endpoint, then
starts the backend and frontend. Process output is written under
`.demo-logs/`; the script prints the three process IDs and URLs.

## 11. Automated proof

The integration smoke test performs the same lifecycle through the real Fiber routes using a temporary registry and memory store: administrator registration, provider creation, Builder and Client creation, policy mutation, workflow creation, assignment, Client login, safe mock execution, and unsafe dispatch blocking.

```powershell
cd backend
go test ./tests/integration -run TestGovernedDemoFlowThroughRealRoutes -count=1 -v
```

For the full project checks:

```powershell
cd backend
go test ./...
go build ./...
```

```powershell
cd frontend
npm test
npm run lint
npm run build
```

## Optional: run the Python semantic service without Ollama

The quick demo above deliberately uses the Go lexical fallback. For the research retrieval path, run the Python FAISS service with Sentence Transformers in a third PowerShell terminal:

```powershell
cd backend\semantic_search_service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m pip install sentence-transformers==3.3.1

$env:DATASET_ROOT="..\dataset"
$env:EMBEDDING_PROVIDER="sentence_transformers"
$env:EMBEDDING_MODEL="sentence-transformers/all-MiniLM-L6-v2"
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
$env:SEMANTIC_SEARCH_LOG_LEVEL="INFO"

python -m uvicorn app:app --host 127.0.0.1 --port 8090
```

Verify it:

```powershell
Invoke-RestMethod http://127.0.0.1:8090/health
Invoke-RestMethod http://127.0.0.1:8090/index/status
```

For research runs where external semantic retrieval is mandatory, restart the Go backend with:

```powershell
$env:SEMANTIC_SEARCH_MODE="external_embedding"
$env:SEMANTIC_SEARCH_URL="http://127.0.0.1:8090/search"
$env:SEMANTIC_FALLBACK="off"
go run ./cmd/server
```

With fallback off, an unavailable service on port `8090` correctly fails retrieval instead of silently changing the experimental method.

## Return to real integrations

Stop the demo backend and clear or replace the demo-only settings before using real tools:

```powershell
$env:MCP_MODE="remote"
$env:MCP_BASE_URL="https://your-mcp-service.example"
$env:SEMANTIC_FALLBACK="off"
```

The standalone mock ERP is a downstream demo integration, not a validation
engine. In production the server refuses a detected `mock-erp` backend, and
the mock ERP binary itself refuses to start with `APP_ENV=production`.
