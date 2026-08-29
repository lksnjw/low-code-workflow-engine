# TypeScript backend port

This folder contains the isolated TypeScript backend. It listens on `:8081` by default, while the reference Go backend can continue listening on `:8080`. The TypeScript runtime does not import or start the Go backend.

## Run

Requirements: Node.js 22 or newer.

```powershell
npm install
npm run dev
```

The default memory storage is intentionally non-durable. For durable storage, set `STORAGE_DRIVER=postgres`, `DATABASE_URL`, and a 32-byte `STORAGE_ENCRYPTION_KEY` encoded as base64, hex, or a literal value. Runtime registry files are created under `configs/runtime/` from the frozen copies stored in this folder's parity fixtures.

For the OpenRouter demo path, configure the OpenAI-compatible provider with a pinned model ID:

```powershell
$env:GENERATION_BASE_URL = "https://openrouter.ai/api/v1"
$env:GENERATION_API_KEY = "[REDACTED]"
$env:GENERATION_MODEL_PRIMARY = "openai/gpt-4o-mini-2024-07-18"
$env:GENERATION_MODEL_FALLBACK = ""
$env:GENERATION_TIMEOUT_MS = "30000"
$env:GENERATION_TEMPERATURE = "0"
$env:GOVERNANCE_URL = "https://policy-source.example/evaluate"
$env:GOVERNANCE_API_KEY = "[REDACTED]"
$env:GOVERNANCE_TIMEOUT_MS = "10000"
$env:GOVERNANCE_SECONDARY_URL = ""
$env:GOVERNANCE_CACHE_TTL_MS = "60000"
npm run dev
```

The model string is passed through unchanged. Do not use a floating alias such as `:latest`. Mock MCP mode supports `demo.echo` and the realistic read-only `fetch_attendance` demo action; configuration rejects mock mode when `APP_ENV=production`.

## ERPBridge MCP transport

The default `MCP_TRANSPORT=bridge-v1` preserves the existing bridge client. To use authenticated ERPBridge MCP, set `MCP_TRANSPORT=erpbridge-mcp` and provide a scoped `mcp` token. The engine calls ERPBridge `/mcp/` through its private SDK adapter; it does not use the admin-only `/api/tools/invoke` endpoint.

```powershell
$env:MCP_TRANSPORT = "erpbridge-mcp"
$env:ERPBRIDGE_BASE_URL = "https://erpbridge.example"
$env:ERPBRIDGE_MCP_TOKEN = "[REDACTED]"
$env:ERPBRIDGE_ROLE_MAP = '{"Workflow Builder":"workflow_builder","Client":"client"}'
npm run dev
```

Instead of putting the token in the process configuration value, select a secret-manager environment variable by name:

```powershell
$env:ERPBRIDGE_MCP_TOKEN_ENV = "WORKFLOW_ERPBRIDGE_TOKEN"
```

`ERPBRIDGE_MCP_TOKEN` and `ERPBRIDGE_MCP_TOKEN_ENV` are mutually exclusive. The role map is strict JSON, accepts the built-in local role names only, and rejects duplicate ERPBridge target roles. Non-development endpoints must use HTTPS. Do not include the token in logs, diagnostics, or public configuration responses.

See [ERPBridge integration](docs/ERPBRIDGE_INTEGRATION.md) for the role matrix, token rotation, deployment checks, and audit boundary.

## Verify

```powershell
npm run verify
```

That command type-checks, runs the test suite, and builds the production artifact.

The runtime security claims are deliberately narrower than the Go compile-time claims; see [docs/INVARIANTS.md](docs/INVARIANTS.md) and [docs/MIGRATION.md](docs/MIGRATION.md).
