# Chat Embedding Search and Gemini Pipeline

## 1. What This Pipeline Does

The backend implements a research-grade chat-to-workflow pipeline:

```text
Frontend chat input
-> Go/Fiber chat endpoint
-> dataset-backed embedding semantic search
-> retrieved tools, rules, templates, and few-shot examples
-> Gemini YAML workflow candidate generation
-> Go parser
-> full registry semantic validation
-> candidate scoring and selection
-> selected validated YAML response
```

Gemini is used only for YAML generation. It is not used for search, validation, ranking, approval, or execution.

## 2. Dataset Folder Loading

The backend loads the dataset from:

```env
DATASET_ROOT=./dataset
```

Expected folders:

```text
dataset/
  01_tool_registries/
  02_governance_rules/
  03_process_templates/
  04_test_scenarios/
  05_validator_cases/
```

The Go loader scans available JSON files. Missing optional folders are logged as warnings. Startup fails clearly if no tools or no governance rules are loaded.

Loaded data:

- tools -> full in-memory tool registry
- rules -> full in-memory governance rule registry
- process templates -> prompt context
- test scenarios -> few-shot examples

Validation always uses the full loaded tool/rule registry, not only retrieved search results.

## 3. Embedding Semantic Search

Default retrieval mode:

```env
SEMANTIC_SEARCH_MODE=external_embedding
SEMANTIC_SEARCH_URL=http://localhost:8090/search
SEMANTIC_SEARCH_ALLOW_LEXICAL_FALLBACK=false
```

The Go backend calls the Python search service:

```http
POST http://localhost:8090/search
```

The Python service uses:

- local Ollama embedding model by default, usually `nomic-embed-text`
- FAISS in-memory vector index
- dataset JSON documents

Returned context includes:

- tools
- rules
- templates
- examples

Lexical fallback exists only when explicitly enabled:

```env
SEMANTIC_SEARCH_ALLOW_LEXICAL_FALLBACK=true
```

## 4. Gemini Generation

Workflow generation provider:

```env
WORKFLOW_GENERATION_PROVIDER=gemini
GEMINI_MODEL=gemini-2.5-flash
GEMINI_API_KEY=[REDACTED]
CANDIDATE_COUNT=5
```

Local workflow-generation models such as Ollama, Phi-3, Llama, or other local LLMs are not used as the final generation path.

Gemini receives:

- authenticated backend user role
- original user request
- retrieved tools
- retrieved governance rules
- retrieved process templates
- retrieved few-shot examples
- strict YAML schema
- safety instructions

Gemini returns candidate blocks:

```yaml
--- candidate_1 ---
name: ...
description: ...
trigger:
  type: manual
  displayName: Manual Trigger
  config: {}
steps:
  - id: step_1
    action: procurement.create_purchase_order
    description: Create PO
    parameters: {}
    retryCount: 1
    onError: stop
```

## 5. Few-Shot Prompting

Few-shot examples come from retrieved dataset scenarios and templates.

The prompt includes 2-5 relevant examples when available. These examples show the structure Gemini should follow, but Gemini is still not trusted. Every output candidate is validated by Go.

## 6. Candidate Parsing

The parser supports:

- Gemini candidate blocks: `--- candidate_1 ---`
- JSON wrapper format from earlier tests
- single YAML fallback parsing for compatibility

Each parsed candidate stores:

- `candidate_id`
- `raw_yaml`
- `model_name`
- `generation_metadata`
- `parse_error`

## 7. Full Registry Validation

Validator:

```text
internal/core/validator/registry_validator.go
```

Implemented checks:

- YAML parse validity
- schema validity
- tool existence
- hallucinated tool blocking
- tool status and capability gaps
- required parameters
- RBAC
- governance rules
- amount and quantity thresholds
- process order
- separation of duties
- risk/human approval
- audit-required controls
- sensitive parameter blocking

Scoring:

| Check | Weight |
|---|---:|
| Schema validity | 0.20 |
| Tool validity | 0.20 |
| Parameter completeness | 0.20 |
| RBAC compliance | 0.15 |
| Policy compliance | 0.15 |
| Process-order compliance | 0.05 |
| Risk-control compliance | 0.05 |

A candidate can execute only when every mandatory check passes.

## 8. Candidate Selection

Selection rules:

1. Only `passed=true` candidates are eligible.
2. Select highest validation score.
3. Tie-breaker: lowest risk.
4. Tie-breaker: fewer steps.
5. Tie-breaker: earliest candidate.

If no candidate passes, response has:

```json
{
  "can_execute": false,
  "selected_candidate_id": "",
  "selected_workflow_yaml": "",
  "next_action": "regenerate_or_request_clarification"
}
```

## 9. Chat Endpoint

Endpoint:

```http
POST /api/chat/sessions/:id/messages
```

Request:

```json
{
  "content": "Create a purchase order for 150 laptops from vendor V-882 and send it for approval.",
  "mode": "generate_workflow",
  "top_k_tools": 10,
  "top_k_rules": 15,
  "top_k_templates": 5,
  "top_k_examples": 5,
  "generate_candidates": 5
}
```

Response includes:

- assistant message
- retrieval method and context
- candidate YAML
- validation report for every candidate
- selected candidate
- selected YAML
- `can_execute`
- blocking errors if any

## 10. Catalog and Dev Endpoints

Tool catalog:

```http
GET /api/tools/catalog
GET /api/tools/catalog?module=procurement
GET /api/tools/catalog?role=procurement_officer&status=active_mcp_schema_present
```

Rule catalog:

```http
GET /api/rules/catalog
GET /api/rules/catalog?domain=procurement&enabled=true
```

Semantic search test:

```http
POST /api/semantic-search
```

Canvas validation:

```http
POST /api/canvas/validate-workflow
```

If `yaml` is provided, backend validates it using the same full semantic validator. Node/edge-to-YAML conversion is marked as a clear TODO when YAML is not provided.

## 11. Running the Semantic Search Service

```powershell
ollama pull nomic-embed-text
cd "C:\Users\LKsnj\Desktop\RESEARCH_LAKSHAN\IMPLIMENTATION\low-code-workflow-engine\backend\semantic_search_service"
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

Check:

```text
http://localhost:8090/health
```

Index/cache status:

```text
http://localhost:8090/index/status
```

The first startup builds `.cache/index_<fingerprint>.faiss`, `.cache/documents_<fingerprint>.json`, `.cache/embeddings_<fingerprint>.npy`, and `.cache/metadata_<fingerprint>.json`. Later startups load the same fingerprint from cache unless `REBUILD_SEMANTIC_INDEX=true`.

In development, tools, governance rules, and process templates are fully indexed. Scenario examples stay sampled at 25 per file for startup speed; set `INDEX_MAX_EXAMPLES_PER_FILE=0` to embed every scenario too.

For slower machines or if Ollama returns a batch `400 Bad Request`, use:

```powershell
$env:EMBED_BATCH_SIZE="8"
$env:EMBEDDING_TEXT_MAX_CHARS="1500"
```

## 12. Running the Go Backend

In another terminal:

```powershell
cd "C:\Users\LKsnj\Desktop\RESEARCH_LAKSHAN\IMPLIMENTATION\low-code-workflow-engine\backend"
go run -buildvcs=false ./cmd/server
```

Obtain an access token by registering the first development account or by
calling `POST /api/auth/login`, then send:

```text
Authorization: Bearer <access-token>
```

Browser WebSocket handshakes cannot add an Authorization header, so only the
`/ws/*` handshake route also accepts:

```text
?token=<access-token>
```

## 13. Current Limitations

- The embedding service is a separate Python process.
- Vector index is in memory and rebuilt at service startup.
- Node/edge canvas-to-YAML conversion is not implemented yet.
- The dataset marks many recommended ERP capabilities as future capabilities, so the validator may correctly block them until executable MCP schemas exist.
- Self-healing regeneration is still a scaffold, not a full validation-feedback repair loop.
