# Integrations, persistence, authentication, and authorization

## 6.1 MCP bridge

### Construction and modes

`NewMCPClient(baseURL, timeout)` creates an `http.Client` with the supplied total timeout and defaults to `remote`. `SetMode` trims/lowercases and accepts only `remote` or `mock`. [backend/internal/tools/mcp_client.go:15-60](../../backend/internal/tools/mcp_client.go)

Every call is checked before transport, in this exact order: capability must be usable; capability action must equal requested action case-sensitively; resolved parameters must JSON-marshal; SHA-256 of those exact JSON bytes must equal the capability's parameter hash. Failure returns locally and sends nothing. [backend/internal/tools/mcp_client.go:62-76](../../backend/internal/tools/mcp_client.go)

### Remote wire contract

Remote mode requires nonblank `MCP_BASE_URL`; it does not silently simulate. It sends:

```http
POST <MCP_BASE_URL>/tools/execute
Content-Type: application/json

{"action":"<tool action>","parameters":<the exact previously hashed JSON object>}
```

The request uses the runner/request context plus the configured client timeout. URL construction is literal concatenation, so a trailing slash in base URL produces a double slash. [backend/internal/tools/mcp_client.go:81-104](../../backend/internal/tools/mcp_client.go)

Any status below 400 is treated as success and its body must decode to one JSON object (`map[string]interface{}`). A status of 400 or greater returns `MCPHTTPError{StatusCode}` and deliberately discards the body. Transport and decode failures are wrapped; no retry occurs in the client or runner. [backend/internal/tools/mcp_client.go:102-120](../../backend/internal/tools/mcp_client.go)

### Mock mode

Mock mode still requires and verifies a real dispatch capability. It supports exactly action `demo.echo`; every other action fails. Success copies the parameter map shallowly and returns `{"action":"demo.echo","mock":true,"echo":<copy>}` without network access. [backend/internal/tools/mcp_client.go:62-79](../../backend/internal/tools/mcp_client.go) [backend/internal/tools/mcp_client.go:123-138](../../backend/internal/tools/mcp_client.go)

`GenericMCPTool` normally uses its configured action; only an empty action takes the action from the capability. [backend/internal/tools/mcp_client.go:140-162](../../backend/internal/tools/mcp_client.go)

## 6.2 LLM providers

Workflow synthesis and analysis share the same provider selection and HTTP clients. An active runtime `ProviderConfig` overrides static provider configuration; otherwise configured `gemini` or `ollama` is selected. An override model, when nonblank, replaces the configured model for that request. [backend/internal/core/synthesizer/ollama_client.go:174-250](../../backend/internal/core/synthesizer/ollama_client.go) [backend/internal/core/synthesizer/analysis.go:10-39](../../backend/internal/core/synthesizer/analysis.go)

Synthesis builds its prompt, calls the provider once, returns trimmed/fence-stripped text as YAML, hard-codes confidence `0`, and reports input/output tokens, cost `0`, provider/model, measured flag, and temperature. Provider failures propagate and no synthesizer-level retry/fallback occurs. [backend/internal/core/synthesizer/ollama_client.go:84-104](../../backend/internal/core/synthesizer/ollama_client.go)

### Gemini

- Default model is `gemini-2.5-flash`; base URL is `https://generativelanguage.googleapis.com/v1beta`; total HTTP timeout is 60 s; redirects are disabled. Missing API key fails before request. [backend/internal/core/synthesizer/gemini_client.go:14-31](../../backend/internal/core/synthesizer/gemini_client.go) [backend/internal/core/synthesizer/gemini_client.go:39-46](../../backend/internal/core/synthesizer/gemini_client.go)
- Endpoint: `POST <base>/models/<path-escaped-model>:generateContent`. Headers are `Content-Type: application/json` and `x-goog-api-key: [REDACTED]`. Body is `{"contents":[{"role":"user","parts":[{"text":"<prompt>"}]}],"generationConfig":{"temperature":<configured>,"topP":0.8,"maxOutputTokens":8192}}`. [backend/internal/core/synthesizer/gemini_client.go:48-83](../../backend/internal/core/synthesizer/gemini_client.go)
- Response reads `candidates[].content.parts[].text`, optional `error.{message,status}`, and optional `usageMetadata.{promptTokenCount,candidatesTokenCount}`. Decode failure is wrapped. HTTP >=400 or error message returns only `gemini returned HTTP N`; transport error is reduced to `gemini request failed`. First nonblank text is trimmed and Markdown fence stripped. No text is an error. Usage is measured only when metadata object exists. [backend/internal/core/synthesizer/gemini_client.go:89-133](../../backend/internal/core/synthesizer/gemini_client.go)

### Ollama

- Runtime clients use total timeout 45 s. Disabled client fails locally. [backend/internal/core/synthesizer/ollama_client.go:61-71](../../backend/internal/core/synthesizer/ollama_client.go) [backend/internal/core/synthesizer/ollama_client.go:258-266](../../backend/internal/core/synthesizer/ollama_client.go)
- Endpoint: `POST <baseURL>/api/generate`; `Content-Type: application/json`; body `{"model":"<selected>","prompt":"<prompt>","stream":false,"options":{"temperature":<configured>}}`. [backend/internal/core/synthesizer/ollama_client.go:268-289](../../backend/internal/core/synthesizer/ollama_client.go)
- Response fields are `response`, `error`, optional `prompt_eval_count`, optional `eval_count`. Decode failure is wrapped. HTTP >=400 or nonblank error returns `ollama returned N: <provider error>`; transport cause is wrapped. Response text is returned as-is, including blank/fenced text. Token usage is measured only if both count fields are present. [backend/internal/core/synthesizer/ollama_client.go:292-314](../../backend/internal/core/synthesizer/ollama_client.go)

### OpenAI-compatible

- Requires nonblank base URL, API key, and configured model; total timeout 60 s. [backend/internal/core/synthesizer/openai_client.go:13-37](../../backend/internal/core/synthesizer/openai_client.go)
- Endpoint: `POST <trimmed-base>/chat/completions`. Headers are `Content-Type: application/json` and `Authorization: Bearer [REDACTED]`. Body is `{"model":"<selected>","messages":[{"role":"user","content":"<prompt>"}],"temperature":<configured>}`. [backend/internal/core/synthesizer/openai_client.go:39-56](../../backend/internal/core/synthesizer/openai_client.go)
- Response reads `choices[].message.content` and optional `usage.{prompt_tokens,completion_tokens}`. Decode and transport errors suppress underlying details. Non-2xx returns only the status. First nonblank choice is trimmed/fence-stripped; no text is an error. Usage is measured only when `usage` exists. [backend/internal/core/synthesizer/openai_client.go:57-89](../../backend/internal/core/synthesizer/openai_client.go)

Analysis-provider responses carry text/provider/model and measured token counts. The runner adds one retry only when returned text cannot decode/validate against the requested schema; transport/provider errors are never retried. [backend/internal/core/analysisprovider/provider.go:5-17](../../backend/internal/core/analysisprovider/provider.go) [backend/internal/core/runner/analysis.go:92-115](../../backend/internal/core/runner/analysis.go)

## 6.3 Semantic search

Both constructors create a 30 s HTTP client and prebuild lexical document caches. A non-dataset service defaults to `go_lexical` with fallback enabled; dataset service defaults to `external_embedding` and takes the configured fallback flag/URL. [backend/internal/core/semanticsearch/service.go:17-30](../../backend/internal/core/semanticsearch/service.go) [backend/internal/core/semanticsearch/service.go:69-94](../../backend/internal/core/semanticsearch/service.go)

`SearchContext` changes nonpositive top-K values to tools 10, rules 15, templates 5, examples 5. Requested mode overrides default. Only case-insensitive `external_embedding` invokes the external service; any other mode runs local lexical scoring and echoes that mode string in `method`/`retrieval_method`. [backend/internal/core/semanticsearch/service.go:96-125](../../backend/internal/core/semanticsearch/service.go)

External search sends:

```http
POST <SEMANTIC_SEARCH_URL>
Content-Type: application/json

{
  "query":"...",
  "user_role":"...",
  "top_k_tools":10,
  "top_k_rules":15,
  "top_k_templates":5,
  "top_k_examples":5
}
```

Blank URL, request/transport error, any HTTP status >=400, or decode failure is an error. With lexical fallback enabled that error is swallowed and local result method becomes `go_lexical`; otherwise it propagates. [backend/internal/core/semanticsearch/service.go:113-124](../../backend/internal/core/semanticsearch/service.go) [backend/internal/core/semanticsearch/service.go:160-192](../../backend/internal/core/semanticsearch/service.go)

External response is `{query,retrieval_method,tools,rules,templates,examples}`, where every item may contain `{id,name,display_name,rule_id,rule_name,score,match_reason,source_file,original}`. Embedded `original` is best-effort decoded. Tool/rule identity is then replaced by authoritative local registry content when found, so external definitions do not override evaluated tool/rule metadata. Global safety rules always come from the local registry. [backend/internal/core/semanticsearch/service.go:195-317](../../backend/internal/core/semanticsearch/service.go)

Operational health/metadata/rebuild requests parse the configured search URL, replace its entire path with `/health`, `/index/status`, or `/index/rebuild`, clear query, send the requested method with no body, require 2xx, and decode arbitrary JSON. They use the same 30 s client and do not use lexical fallback. [backend/internal/core/semanticsearch/service.go:32-62](../../backend/internal/core/semanticsearch/service.go) [backend/internal/api/handlers/catalog_handler.go:55-86](../../backend/internal/api/handlers/catalog_handler.go)

## 6.4 Registry loading, versions, mutation, and frozen/runtime split

### Server startup load

The server first ensures both configured runtime files exist. It rejects protected frozen-directory paths; never overwrites an existing runtime file; and on first creation either byte-copies the frozen source (`copy`, default) or writes `[]\n` (`empty`) using exclusive create and mode `0600`. It fsyncs the file and removes incomplete output on failure. [backend/internal/config/runtime_registry.go:22-115](../../backend/internal/config/runtime_registry.go)

`LoadBundle` reads the two JSON arrays. Blank/missing paths produce empty registries with version `empty`/`missing`; other read or JSON errors fail. A loaded file's version is `sha256:` plus the first 16 hex digits of SHA-256 over exact file bytes. [backend/internal/core/registry/loader.go:24-38](../../backend/internal/core/registry/loader.go) [backend/internal/core/registry/loader.go:75-118](../../backend/internal/core/registry/loader.go)

Dataset/frozen evaluation loading scans sorted `.json` filenames, assigns source paths, deduplicates by normalized ID/name with later files winning, sorts records by ID, and hashes each full file-path byte sequence followed by its bytes; the published version is again truncated to 16 hex digits. Tool/rule folder absence or decode error ultimately fails when none exist; invalid optional template/example files are logged and skipped. [backend/internal/core/registry/loader.go:40-72](../../backend/internal/core/registry/loader.go) [backend/internal/core/registry/loader.go:120-173](../../backend/internal/core/registry/loader.go) [backend/internal/core/registry/loader.go:176-289](../../backend/internal/core/registry/loader.go)

### Runtime mutation/publication

Create/update/import decodes strict JSON with unknown-field rejection and exactly one value. Required tool/rule fields are checked. The manager mutex serializes mutation; it constructs a prospective full array, writes indented JSON plus newline to a same-directory temporary file, fsyncs/closes it, then renames into place with a backup fallback. Only after successful persistence does it atomically replace the in-memory registry snapshot/version. [backend/internal/core/registry/manager.go:336-424](../../backend/internal/core/registry/manager.go) [backend/internal/core/registry/manager.go:137-260](../../backend/internal/core/registry/manager.go)

Bulk imports decode and validate every item and collision before any write; errors are per zero-based input index and the operation is all-or-nothing. Updates require explicit `allowUpdates=true`. [backend/internal/core/registry/bulk_import.go:27-109](../../backend/internal/core/registry/bulk_import.go) [backend/internal/core/registry/bulk_import.go:111-189](../../backend/internal/core/registry/bulk_import.go)

There is no file watcher or general reload loop. Server-originated mutations publish immediately; external edits become active only on restart or through the explicit restored-bundle publication used by the import rollback pipeline. [backend/internal/core/registry/manager.go:246-260](../../backend/internal/core/registry/manager.go) [backend/internal/core/registry/import_accessors.go:56-71](../../backend/internal/core/registry/import_accessors.go)

Frozen evaluation paths are any resolved path containing adjacent components `configs/registries`; the guard resolves symlinks where possible. Runtime server config additionally requires tool/rule paths inside `configs/runtime`. Thus frozen files are immutable evaluation evidence, while the server evaluates and writes separate runtime copies. [backend/internal/core/registry/import_accessors.go:30-54](../../backend/internal/core/registry/import_accessors.go) [backend/internal/config/config.go:160-175](../../backend/internal/config/config.go)

## 6.5 Persistence

### Driver selection and memory behavior

`STORAGE_DRIVER` blank/`memory` returns no `StateStore`; `postgres` requires `DATABASE_URL`; other values fail. Memory mode still uses the same locked maps but installs no durability hook: all store business/auth/audit/upload state is lost on process exit. Registry JSON files are outside this store and survive independently. [backend/internal/storage/storage.go:9-32](../../backend/internal/storage/storage.go) [backend/internal/repository/memory.go:28-60](../../backend/internal/repository/memory.go)

### PostgreSQL storage

Startup parses the DSN without echoing it on parse failure, connects/pings, runs embedded upward migrations under a PostgreSQL advisory transaction lock, reserves one connection, and obtains a session advisory writer lock for state key `default`. A second backend writer for that key fails startup. [backend/internal/storage/postgres.go:19-77](../../backend/internal/storage/postgres.go) [backend/internal/storage/postgres.go:152-235](../../backend/internal/storage/postgres.go)

The database stores one opaque `BYTEA` payload in `runtime_state(state_key,payload,updated_at)`. Load selects it; save performs an upsert; probe executes `SELECT 1`. All three serialize through `writerMu` on the reserved connection. Close attempts advisory unlock with a 2 s context, releases the connection, then closes the pool. [backend/internal/storage/postgres.go:80-150](../../backend/internal/storage/postgres.go)

### State envelope and encryption

Plaintext is compact JSON version 1 with exact top-level keys:

```json
{
  "version":1,
  "counter":0,
  "users":{}, "passwordHashes":{}, "refreshSessions":{},
  "roles":{}, "permissions":[],
  "workflows":{}, "versions":{}, "templates":{},
  "executions":{}, "executionLogs":{}, "timelines":{}, "healing":{},
  "chats":{}, "company":null, "settings":{}, "providers":{},
  "integrations":{}, "webhooks":{}, "auditLogs":{},
  "notifications":{}, "notificationPreferences":{}, "apiKeys":{},
  "uploads":{}, "uploadContents":{}
}
```

Hidden workflow YAML/canvas/archive, provider API key, and stored API-key secret/hash are explicitly reintroduced into storage wrapper objects; derived user role/permission snapshots are stripped and recomputed on restore. [backend/internal/repository/persistent_store.go:175-228](../../backend/internal/repository/persistent_store.go) [backend/internal/repository/persistent_store.go:230-310](../../backend/internal/repository/persistent_store.go)

Serialization is `json.Marshal`, then encryption, then state-store save. AES-256-GCM key input may be standard base64, hex, or literal exact 32 bytes. Payload bytes are `ASCII "LCWE_STATE_V1" || random GCM nonce || ciphertext+tag`, with the magic prefix also used as authenticated additional data. Wrong magic/length rejects; authentication failure reports key mismatch or tampering without plaintext. [backend/internal/storage/codec.go:15-98](../../backend/internal/storage/codec.go) [backend/internal/repository/persistent_store.go:152-165](../../backend/internal/repository/persistent_store.go)

Restore decrypts, JSON-decodes, requires version exactly 1, restores every envelope collection, advances the ID counter monotonically, adds newly required permission definitions/built-in roles without restoring removed role permissions, and migrates legacy user permission snapshots to the closest role by symmetric set difference. [backend/internal/repository/persistent_store.go:313-391](../../backend/internal/repository/persistent_store.go) [backend/internal/repository/persistent_store.go:394-505](../../backend/internal/repository/persistent_store.go)

### Locking, save failure, and restart loss

`StoreMutex.Unlock` invokes synchronous persistence while its write lock remains held, using a 2 s background timeout. A successful save replaces the in-memory committed plaintext snapshot. Failure restores that snapshot, marks health false, increments a monotonic failure generation, and reports the error callback. Initial construction immediately saves even a new/restored store, so read-only/unwritable storage fails startup. [backend/internal/repository/persistent_store.go:18-40](../../backend/internal/repository/persistent_store.go) [backend/internal/repository/persistent_store.go:52-102](../../backend/internal/repository/persistent_store.go) [backend/internal/repository/persistent_store.go:152-173](../../backend/internal/repository/persistent_store.go)

Mutation middleware also serializes durable HTTP mutations, refuses new ones when unhealthy, and detects a failed save generation after the handler. [backend/internal/api/middlewares/persistence.go:13-63](../../backend/internal/api/middlewares/persistence.go)

PostgreSQL preserves every envelope field, but not process-only state: validation-token HMAC key/tokens, request rate-limit counters, WebSocket connections, execution-local caches, and uncommitted per-step progress. A crash-visible `RUNNING` execution is marked failed at next startup. [backend/internal/core/validator/registry_validator.go:47-69](../../backend/internal/core/validator/registry_validator.go) [backend/internal/core/runner/executor.go:61-76](../../backend/internal/core/runner/executor.go) [backend/internal/api/handlers/execute_handler.go:555-593](../../backend/internal/api/handlers/execute_handler.go)

## 6.6 Authentication and RBAC

### Passwords, access tokens, and middleware

Passwords use bcrypt default cost for bootstrap, registration, and administrator-created accounts. Login performs a dummy-hash comparison when the email/hash is absent to reduce account-existence timing differences. [backend/internal/authn/password.go:5-17](../../backend/internal/authn/password.go) [backend/internal/api/handlers/auth_handler.go:15-45](../../backend/internal/api/handlers/auth_handler.go)

Access tokens are JWT HS256 with exactly application-supplied claims `sub` user ID, `iat` Unix seconds, and `exp` Unix seconds based on configured TTL. The response `expiresIn` is integer TTL seconds. [backend/internal/api/handlers/handler.go:195-212](../../backend/internal/api/handlers/handler.go)

Auth middleware reads `Authorization`, removes one exact case-sensitive prefix `Bearer `, and trims. Only `/ws/` paths may fall back to query `token`. It parses with the configured JWT secret and permits only HS256; the library validates time claims. It then requires string `sub` and stores it in request locals. [backend/internal/api/middlewares/auth.go:13-45](../../backend/internal/api/middlewares/auth.go)

The protected group then calls `RequireUser`, which reloads the user and requires current status case-insensitive `active`. Deletion invalidates access on the next request; suspension produces 403. Tokens carry no role/permission claims. [backend/internal/api/routes/routes.go:30-44](../../backend/internal/api/routes/routes.go) [backend/internal/api/handlers/handler.go:119-131](../../backend/internal/api/handlers/handler.go)

### Refresh rotation

A refresh token is opaque `refresh_` plus 24 cryptographic random bytes as 48 lowercase hex characters; the generic random helper falls back to Unix nanoseconds if entropy fails. Only SHA-256 hex digest is stored as map key with user ID/expiry. Login expiry is 7 days or 30 with remember-me; registration is 7 days. [backend/internal/api/handlers/handler.go:208-220](../../backend/internal/api/handlers/handler.go) [backend/internal/api/handlers/auth_handler.go:55-63](../../backend/internal/api/handlers/auth_handler.go) [backend/internal/api/handlers/auth_handler.go:120-137](../../backend/internal/api/handlers/auth_handler.go)

Refresh locks the store, looks up the digest, and deletes it immediately whenever found—before expiry/user/status/signing checks. A valid active user receives a new access/refresh pair and the replacement digest always expires in 7 days (remember-me is not carried forward). Therefore every presented stored token is single-use even when refresh later fails. [backend/internal/api/handlers/auth_handler.go:160-191](../../backend/internal/api/handlers/auth_handler.go)

Logout optionally deletes the supplied refresh digest and always succeeds. Access JWTs are not revoked/blacklisted. User suspension/deletion removes all their refresh sessions, while existing access tokens are stopped by `RequireUser`. [backend/internal/api/handlers/auth_handler.go:147-157](../../backend/internal/api/handlers/auth_handler.go) [backend/internal/api/handlers/admin_handler.go:301-310](../../backend/internal/api/handlers/admin_handler.go)

### Effective permissions and enforcement

Every permission check derives a fresh immutable user snapshot. Effective permissions are the ordered, deduplicated, case-sensitive union of the current role's permissions followed by additive user overrides; blanks are removed. Missing role fails closed except for explicit overrides. No permission result is cached or embedded in JWT. [backend/internal/repository/memory.go:134-188](../../backend/internal/repository/memory.go)

Built-in defaults are:

- Platform Admin: all 14 declared permissions.
- System Admin: `user:manage`, `registry:read`, `audit:read`.
- Workflow Builder: `workflow:read`, `workflow:write`, `workflow:run`, `workflow_view_all`, `chat:use`, `registry:read`.
- Client: `chat:use`, `workflow:read_own`, `workflow:run_own`, `execution:read_own`. [backend/internal/repository/memory.go:62-129](../../backend/internal/repository/memory.go)

`RequirePermission` uses exact string equality and returns 403 meta `{required:<key>}`. `RequireAnyPermission` checks required-list order against granted-list order and returns meta `{requiredAny:[...]}`. [backend/internal/api/middlewares/rbac.go:8-30](../../backend/internal/api/middlewares/rbac.go)

Route middleware creates exact/any guards for workflow, execution, chat, settings, provider, registry, users, and audit. Own-vs-all authorization is then enforced inside workflow/chat/execution scope helpers; records outside scope are usually hidden as 404. [backend/internal/api/routes/routes.go:30-44](../../backend/internal/api/routes/routes.go) [backend/internal/api/handlers/scope_helper.go:21-62](../../backend/internal/api/handlers/scope_helper.go)

Some handlers add stricter role policy beyond permission middleware: provider management and registry entry writes require the built-in Platform Admin identity; company write/full sensitive reads accept Platform or System Admin. Role/user administration also prevents granting permissions the actor lacks and preserves a minimum permission floor on Platform Admin. [backend/internal/core/validator/registry_validator.go:751-785](../../backend/internal/core/validator/registry_validator.go) [backend/internal/api/handlers/provider_handler.go:215-227](../../backend/internal/api/handlers/provider_handler.go) [backend/internal/api/handlers/registry_handler.go:177-195](../../backend/internal/api/handlers/registry_handler.go) [backend/internal/api/handlers/admin_handler.go:555-605](../../backend/internal/api/handlers/admin_handler.go)
