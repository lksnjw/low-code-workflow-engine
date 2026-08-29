# Enforcement-strength changes

The TypeScript port deliberately changes one proof mechanism. The existing Go backend and its documentation remain the reference and fallback.

## Capability construction

Weakened: Go can make external capability construction fail at compile time through package-private fields and types. TypeScript cannot preserve that property because its type system is erased and assertions/raw JavaScript can bypass it.

Strengthened at runtime: TypeScript capabilities are registered by object identity in a closure-owned `WeakSet`, cryptographically bound with a process-held HMAC, frozen, short-lived, and single-use. The resolved parameter bytes and action are rechecked immediately before dispatch. The Go capability was not single-use or wall-clock-expiring.

Residual risk: code with sufficient same-process or module-loader authority could tamper with runtime execution. The claim is runtime enforcement, never compile-time unforgeability.

## Async transaction redesign

Strengthened relative to a naive JavaScript translation: repository mutation is owned by an explicit async mutex held across mutation, serialization, persistence, and rollback. Mutating HTTP handlers are serialized for their whole lifetime. Registry file replacement writes a same-directory temporary file, fsyncs it, keeps a backup, and publishes the in-memory snapshot only after rename succeeds.

Not fully preserved: the Go context/import pipeline can roll back coordinated registry and context mutations across multiple files. The current TypeScript importer handles one registry kind per commit and does not yet provide the same two-registry-plus-context transaction. This is a known incomplete port area, not an equivalent guarantee.

## Dependency construction

Strengthened: nullish or structurally invalid repositories, registries, validators, executors, analysis providers, and tools are rejected at composition/registration time. This avoids reproducing Go typed-nil edge behavior.

## Serialization and external services

Partially preserved: strict workflow parsing, canonical hashes, AES-GCM, bcrypt, JWT, registry decoding, and the captured HTTP status/message baseline have executable evidence. Dedicated runtime validators have not yet been authored for every one of the 82 captured boundary types. LLM synthesis/orchestration, semantic-search HTTP integration, automatic healing, full rate limiting, and the complete importer transaction remain incomplete and are not claimed as ported evidence.
