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

## Verify

```powershell
npm run verify
```

That command type-checks, runs the test suite, builds the production artifact, scans it for experiment-only symbols and strings, analyzes the production import graph, starts the production bundle with the experiment variable set to prove it is inert, and builds the separate experiment artifact.

The evidence and known gaps are recorded in [docs/RESULTS.md](docs/RESULTS.md). The runtime security claims are deliberately narrower than the Go compile-time claims; see [docs/INVARIANTS.md](docs/INVARIANTS.md) and [docs/MIGRATION.md](docs/MIGRATION.md).
