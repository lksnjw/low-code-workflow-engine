# TypeScript backend invariants

These claims apply only to the TypeScript production artifact. They do not restate or replace the Go backend's invariants.

## Runtime-governed dispatch

Production tool dispatch is runtime-enforced. A dispatch capability is accepted only when all of the following hold, in order:

1. Its object identity is present in the validator module's closure-owned `WeakSet`.
2. Its closure-held payload has a valid process-keyed HMAC, compared with `timingSafeEqual`.
3. It has not expired.
4. It has not already been consumed.
5. The canonical bytes of the exact business parameters about to be sent have the bound hash.
6. The requested action equals the bound action.
7. The immutable authenticated dispatch identity (`userId`, local role, and mapped ERPBridge role) equals the identity bound at mint time.

Capabilities are frozen, short-lived, and single-use. The mint registry, payload map, signing key, and mint functions are not exported. The legacy bridge HTTP function and the ERPBridge SDK client are reachable only through their governed adapters; the SDK client is private to `src/tools/erpbridge-mcp-client.ts`. Rejection happens before any HTTP or SDK request. This is proved by `tests/capability.test.ts` and `tests/erpbridge-mcp-client.test.ts`.

This is not compile-time enforcement. TypeScript types are erased, assertions can bypass type checking, and raw JavaScript executing with sufficient same-process/module-loader authority could subvert runtime state. Object identity, HMAC binding, expiry, single use, frozen objects, a non-exported mint, and a non-exported transport reduce that risk; they do not recreate Go's package-private compile-fail guarantee.

## Authenticated ERPBridge MCP boundary

`MCP_TRANSPORT=erpbridge-mcp` creates one private `@erpbridge/sdk@1.1.0` MCP session at production startup with the scoped token and `mcpRetryPolicy: "never"`. Local registry definitions remain authoritative: each registered tool supplies the reviewed remote name and input metadata, while `tools/list` is read-only. Guarded calls reject a workflow-provided `role` and inject only the capability-bound mapped ERPBridge role. MCP `isError` envelopes fail the step; successful envelopes are returned without global text parsing. Shutdown closes the private session.

## Deterministic validation boundary

The validator's production dependency closure contains only canonical JSON, runtime models, strict workflow parsing, redaction, and the validator. It contains no HTTP handler, model-provider, synthesis, or entrypoint module.

The frozen 120-case replay compares each verdict, ordered failed-rule list, and ordered error list. Every case is evaluated five times and the serialized evidence must be identical. This is proved by `tests/validator-parity.test.ts`.

## Sequential runner and pre-dispatch order

Workflow steps execute in a `for...of` loop with no concurrent step fan-out. Each tool step performs variable resolution, resolved-policy evaluation, capability minting, registry lookup, and governed dispatch in that order. A missing/forged token, workflow mismatch, registry mismatch, threshold violation, credential-shaped key, forged capability, parameter mutation, action mismatch, expiry, or reuse prevents transport. See `tests/capability.test.ts` and `src/runner/executor.ts`.

## Repository mutation boundary

Every repository mutation runs inside an explicit async mutex. The lock remains held while the aggregate is mutated, serialized, persisted, committed, or rolled back. A persistence failure restores the pre-mutation aggregate. Mutating HTTP requests are additionally serialized across the entire handler, including external calls. `tests/repository.test.ts` proves both lock scope and rollback.

PostgreSQL uses one reserved connection, a session advisory writer lock, one encrypted `BYTEA` aggregate, and a process-local async mutex. The AES-GCM envelope uses `LCWE_STATE_V1` as both prefix and AAD. The fixed Go envelope is replayed in `tests/crypto.test.ts`.

## Strict data boundaries

Workflow YAML accepts exactly one document and uses recursively strict Zod schemas for the workflow structure. Core HTTP boundary schemas reject unknown properties and preserve `null`, empty, zero, and false where declared. Semantically meaningful zero values use explicit checks rather than truthiness defaults. Parser and selected zero-value fixtures are replayed by `tests/parser.test.ts` and `tests/zero-values.test.ts`.

The complete set of 82 captured Go boundary types is not yet represented by dedicated TypeScript runtime schemas. Therefore this document does not claim complete serialization parity.
