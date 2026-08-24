# TypeScript port results

Evidence date: 2026-08-23

## Artifact identity

- Production bundle SHA-256: `d115f38854fb8ab5e0fe7012cfdf832986345bd12b79c7dd43e9b0662646a3cf`
- Production metafile SHA-256: `a56a0e3c8a7ce3e39c5ea5423815dda54a3d7d72b54b75810b450e25297c7bf9`
- Experiment bundle SHA-256: `09d99cfcf384195972963d5648d0988054e722ce7b973faef49dee1b6aebe0e6`
- Frozen 120-case fixture SHA-256: `76be9af15f02d2b8858787cccd6114e360e1e5a7a27350bbedc325dfcae5e4e0`
- Captured HTTP fixture SHA-256: `125090b06e8db5b4cc209faa8144b134d26b6998908e01597969acb2757e1120`
- Frozen tool registry SHA-256: `cca3d30f1043f3590d0fe6434e27ea83fd78d6a7e8e7e8cae90055fbb1eef81f`
- Frozen rule registry SHA-256: `e689e1176f117b0f5ba05a113739211dca411c6902b5ca6ead798947157fb5dc`

These are TypeScript-port results. No Go aggregate metric is inherited.

## Verification run

`npm run verify` passed from a clean TypeScript build input:

- TypeScript type-check: passed.
- Vitest: 11 files, 58 tests, all passed.
- Production build: passed, 262.9 KiB bundle.
- Production forbidden-content scan: passed with zero findings across bundle, source map, and metafile.
- Production dependency-boundary analysis: passed.
- Production runtime with the experiment variable set: HTTP 200 from `low-code-workflow-engine-ts`.
- Separate experiment build: passed.

## Demo-path verification

The HTTP-level integration test now proves this complete TypeScript path with a deterministic OpenAI-compatible provider endpoint and the unchanged validator/capability boundary:

```text
chat message
  -> one generated YAML candidate
  -> full registry validation
  -> candidate deployment and version persistence
  -> workflow run
  -> single-use governed dispatch capability
  -> mock ERP fetch_attendance
  -> persisted DONE execution and returned attendance result
```

The self-approval synthesis test separately proves rejection with `GLOBAL-SOD-001` present in the validator result. Candidate generation reads the complete runtime registry directly; semantic retrieval and candidate ranking are intentionally not part of this minimum demo pipeline.

Every provider invocation stores prompt template version, SHA-256 of the fully assembled prompt, provider, model, measured usage, latency, temperature, and outcome. Raw prompt text and API keys are not retained. The automated provider tests use deterministic HTTP responses; no live OpenRouter invocation is claimed because no API key was available during this verification run.

## Parity inventory

| Evidence | Captured | Replayed | Result |
|---|---:|---:|---|
| Explicit HTTP routes | 168 | 168 | Registered exactly |
| Captured HTTP scenarios | 421 | 421 | Status and top-level message match; missing-auth bodies match byte-for-byte |
| Validator cases | 120 | 120 × 5 runs | 120/120 verdict, ordered rule IDs, and ordered errors; determinism 120/120 |
| Parser cases | 15 | 15 | 15/15 |
| Crypto vectors | 6 | 6 | 6/6: AES-GCM, bcrypt, JWT, workflow bytes, parameter bytes, registry hash |
| Zero-value cases | 8 | selected direct proofs plus fixture inventory | Partial; zero retry presentation is not implemented |
| Boundary serialization types | 82 | not fully replayed through dedicated schemas | Captured only; incomplete |
| Go error strings | 3,916 | captured HTTP subset | Full string-by-string reachability replay is incomplete |

The HTTP fixture manifest intentionally remains `complete: false`. It does not contain the success path and every documented stateful error for every route, a live PostgreSQL failure fixture, or determinate WebSocket-library error bytes. Accordingly, this port does not claim 100% full-wire parity. The executable claim is limited to the 421 captured scenarios and the comparisons listed above.

## Dispatch-spy evidence

`tests/capability.test.ts` proves zero remote requests for:

- forged capability shape;
- cloned/mutated capability;
- parameters changed after minting;
- expired capability;
- action mismatch;
- reused capability after one successful request;
- missing validation token;
- workflow-content mismatch;
- registry mismatch;
- over-threshold resolved value;
- credential-shaped resolved key; and
- a capability used with another authenticated dispatch identity.

The one unchanged capability case reaches the spy exactly once. The identity is included in the capability HMAC and the exact business parameter hash excludes the internal action marker, which is never sent to a remote tool.

`tests/erpbridge-mcp-client.test.ts` additionally proves the private adapter uses the reviewed remote MCP name, injects the mapped role only for guarded tools, rejects caller-supplied roles, preserves successful MCP envelopes, fails `isError` envelopes, closes its session, and makes one SDK call after an ambiguous transport failure.

## Production artifact proof

The final scan found none of: `setBaselineB`, `baselineBEnabled`, `auditBaselineBypass`, `ExperimentSafeTool`, the experiment environment-variable name, or the experiment package path.

The production metafile contains no experiment input. The validator dependency closure is:

```text
src/core/canonical-json.ts
src/models/schemas.ts
src/parser/workflow.ts
src/redact/secrets.ts
src/validator/registry-validator.ts
```

No forbidden HTTP, provider, synthesizer, entrypoint, or experiment dependency is reachable. Capability mint functions and the raw HTTP transport are not exported.

## Package-by-package status

| Go package/surface | TypeScript location | Status |
|---|---|---|
| `internal/api/handlers` | `src/http/app.ts`, `src/http/handlers/` | Partial: all routes dispatch and captured baseline matches; complete stateful wire matrix is not captured |
| `internal/api/middlewares` | `src/http/app.ts` | Partial: auth, current-user reload, RBAC, error boundary, and mutation serialization; rate limiting/persistence-generation guard incomplete |
| `internal/api/routes` | `src/http/generated-routes.ts` | Ported: 168 explicit routes |
| `internal/authn` | `src/authn/password.ts`, HTTP auth handlers | Ported for captured bcrypt/JWT behavior |
| `internal/config` | `src/config/config.ts`, registry bootstrap | Substantially ported; production owns its runtime seeds inside `backend-ts` |
| `internal/core/analysisprovider` | `src/analysisprovider/types.ts`, `src/providers/` | Partial: OpenAI-compatible HTTP client, active-provider wiring, measured usage, model propagation, and invocation provenance implemented; Gemini and Ollama clients absent |
| `internal/core/company` | strict schemas and company handlers | Partial: core CRUD/normalization behavior; not a complete standalone package replay |
| `internal/core/context` | registry context handlers | Partial: rendering/history/atomic file write; coordinated rollback incomplete |
| `internal/core/healing` | execution failure reports | Incomplete: no one-shot LLM repair service |
| `internal/core/importer` | registry import handlers | Partial: analyze/commit/history; two-registry/context transaction incomplete |
| `internal/core/orchestrator` | `src/synthesis/service.ts`, chat handlers | Minimum demo path implemented: direct-registry single-candidate generation, full-gate validation, multi-turn chat persistence, and candidate deployment; semantic retrieval, multi-candidate ranking, and repair remain absent |
| `internal/core/registry` | `src/registry/` | Substantially ported: strict load, exact hashes, snapshots, serialized mutation, atomic replacement, bulk all-or-nothing per registry |
| `internal/core/relevance` | workflow scoping/domain fields | Incomplete as a dedicated evaluator/backfill package |
| `internal/core/runner` | `src/runner/executor.ts` | Substantially ported: sequential execution, analysis, partial results, pre-dispatch gate; complete failure/healing parity incomplete |
| `internal/core/semanticsearch` | catalog handler lexical code | Incomplete: local helper exists but service is deliberately unavailable without a configured port; external adapter absent |
| `internal/core/structuredoutput` | `src/structured-output/validate.ts` | Ported implementation; dedicated Go fixture matrix still needed |
| `internal/core/synthesizer` | `src/synthesis/service.ts`, synthesis handlers | Minimum OpenAI-compatible single-candidate synthesis implemented; direct registry context replaces semantic retrieval for the demo path |
| `internal/core/validator` | `src/validator/registry-validator.ts` | Runtime redesign; 120/120 × 5 replay and adversarial dispatch tests pass |
| `internal/models` | `src/models/` | Partial: strict schemas for active boundaries; not all 82 captured types |
| `internal/redact` | `src/redact/secrets.ts` | Ported for recursive secret removal used by storage/log responses |
| `internal/repository` | `src/repository/` | Async redesign with lock-through-save and rollback tests |
| `internal/storage` | `src/storage/` | AES-GCM vector passes; PostgreSQL aggregate/advisory-lock adapter implemented, live failure fixture absent |
| `internal/tools` and `impl` | `src/tools/` | Runtime-governed client and generic registry-backed delegates implemented; mock mode supports `demo.echo` and Go-shaped `fetch_attendance`, and is refused in production; ERPBridge MCP uses private `@erpbridge/sdk@1.1.0` with no retry |
| `pkg/logger` | Fastify structured logger | Functional replacement, not a Zap wire/config clone |
| `pkg/parser` | `src/parser/workflow.ts` | 15/15 parser fixtures pass |

## Unpreserved or unverified behavior

The following prevent an honest “complete backend parity” claim:

- Phase 0 lacks the full per-route success/error wire matrix and live PostgreSQL/WebSocket fixtures.
- Dedicated strict runtime schemas and serialization replays do not yet cover all 82 boundary types.
- Gemini and Ollama clients, semantic-search HTTP integration, multi-candidate ranking/repair, and automatic healing are absent. OpenAI-compatible single-candidate synthesis and chat orchestration are implemented for the demo path.
- Importer commits are not one transaction across both registries and generated context.
- Full auth rate limiting, persistence failure-generation middleware behavior, and complete runner failure classification are incomplete.
- The 3,916-string inventory is captured but not fully exercised.

These limitations are reported rather than hidden behind compile success or route placeholders.
