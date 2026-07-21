# Storage Bootstrap, Restart, and Cutover Flow

This guide covers the two supported runtime-storage modes, the first-account bootstrap, encrypted PostgreSQL persistence, migration behavior, restart verification, and operational limits.

## Supported modes

| `STORAGE_DRIVER` | Dependencies | Restart behavior | Intended use |
|---|---|---|---|
| `memory` (default) | None | Runtime records reset when the backend stops | Local development, tests, governed demo |
| `postgres` | PostgreSQL 16+ and a 32-byte encryption key | Runtime records are restored at backend startup | Durable single-instance deployments |

Memory remains the default for development so a fresh clone starts without Docker or a database. Production validation requires PostgreSQL. PostgreSQL is fail-closed: the backend refuses to start when its URL, encryption key, connection, writer lock, migration, decryption, normalization, or state restoration fails.

## Startup and write path

```mermaid
flowchart TD
    A["Load and validate environment"] --> B{"STORAGE_DRIVER"}
    B -->|"memory"| C["Create empty runtime store"]
    B -->|"postgres"| D["Validate AES-256 key"]
    D --> E["Open pgx connection pool"]
    E --> F["Apply numbered migrations"]
    F --> G{"Encrypted state exists?"}
    G -->|"no"| H["Create policy definitions and encrypted initial state"]
    G -->|"yes"| I["Authenticate and decrypt snapshot"]
    I --> J["Restore users, workflows, runs, chat, settings, and secrets"]
    C --> K["Apply environment-managed settings"]
    H --> K
    J --> K
    K --> L["Start Fiber API"]
    L --> M["Handler mutation under Store lock"]
    M --> N["Serialize a consistent state snapshot"]
    N --> O["AES-GCM encrypt with a fresh nonce"]
    O --> P["UPSERT runtime_state in PostgreSQL"]
```

The persistence hook saves synchronously before the store write lock is released, so every attempted snapshot is internally consistent. PostgreSQL I/O has a two-second timeout. If serialization, encryption, or the database save fails, the store restores the last committed snapshot before releasing the lock and advances a failure generation. The application-level persistence guard serializes mutating HTTP requests, detects that generation, and replaces the response with HTTP `503`; the failed mutation is never acknowledged as committed. Requests arriving while storage is unhealthy perform one short recovery probe and otherwise fail fast without entering a mutating handler.

`/healthz` actively probes the reserved PostgreSQL writer connection. It reports HTTP `503` while the probe fails and returns to HTTP `200` after PostgreSQL recovers, without requiring a business mutation. Snapshot serialization, encryption, and the bounded database save still occur while the global write lock is held, so readers can briefly wait behind a write. Removing that lock safely requires normalized transactional repositories rather than the compatibility snapshot.

## What survives a PostgreSQL restart

The encrypted state envelope preserves:

- users, roles, permissions, password hashes, and refresh-session digests;
- workflow YAML, canvas data, versions, templates, ownership, and Client assignments;
- executions, logs, timelines, healing reports, and audit records;
- chat sessions and messages;
- general, LLM, and RBAC settings;
- provider configurations and full provider API keys;
- integrations, webhooks, notifications, notification preferences, and application API keys;
- upload metadata and upload contents;
- the monotonic runtime ID counter, preventing ID reuse after restart.

Provider keys, application API keys, password hashes, arbitrary secret settings, workflow content, and all other state are inside one AES-256-GCM ciphertext. Fields intentionally hidden from HTTP JSON, such as `ProviderConfig.APIKey`, `APIKey.Key`, workflow YAML/canvas, and archive state, have explicit persistence DTOs so they are not silently dropped.

When a v1 snapshot is restored, the state normalizer preserves custom roles and business records while merging any built-in roles and permission definitions required by the running binary. The normalized envelope is saved before the API starts.

The mutable tool and governance registries remain the JSON files selected by `TOOL_REGISTRY_PATH` and `RULE_REGISTRY_PATH`. Place those files on durable storage in a deployed environment.

## Start with memory storage

From the repository root in PowerShell:

```powershell
cd backend
$env:STORAGE_DRIVER="memory"
go run ./cmd/server
```

No PostgreSQL connection is attempted. This is the mode used by `docs/DEMO.md` unless explicitly overridden.

## Start with encrypted PostgreSQL storage

### 1. Start PostgreSQL

From `backend`:

```powershell
docker compose up -d postgres
docker compose ps
```

Wait until the PostgreSQL container reports `healthy`.

### 2. Generate a unique key

Generate the key once and store it in a secret manager. Do not commit it, paste it into documentation, or rotate it by simply replacing the value.

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$env:STORAGE_ENCRYPTION_KEY = [Convert]::ToBase64String($bytes)
$rng.Dispose()
```

Accepted formats are base64-encoded 32 bytes, 64 hexadecimal characters, or an exact 32-byte literal. Base64 is recommended.

### 3. Start the backend

```powershell
$env:STORAGE_DRIVER="postgres"
$env:DATABASE_URL="postgres://workflow:workflow@127.0.0.1:5432/workflow?sslmode=disable"
$env:JWT_SECRET="replace-with-a-long-random-secret"
go run ./cmd/server
```

Expected startup logs identify only `driver=postgres` and `durable=true`; they never include `DATABASE_URL` or its password. The health endpoint is `http://127.0.0.1:8080/healthz`.

For a full Compose start, keep the generated key in the current shell:

```powershell
$env:STORAGE_DRIVER="postgres"
docker compose up --build
```

Compose supplies the container-network hostname `postgres`; it does not provide a default encryption key.

## First administrator bootstrap

### Development

`ALLOW_PUBLIC_REGISTRATION` defaults to `true` outside production. On a new
empty development store, start the backend and frontend, open
`http://127.0.0.1:5173`, select **Create one free**, and register the first
account. The first account receives the **Platform Admin** role; later public
registrations receive the **Client** role.

To make a development bootstrap explicit, set a non-empty
`BOOTSTRAP_ADMIN_TOKEN` before starting the backend and include that value as
`X-Bootstrap-Token` on the first registration. The sign-up page does not send
that administrative header, so use the API command below when the token is set.

### Production

Production starts fail closed unless all of these conditions are met:

- `JWT_SECRET` is a unique secret of at least 32 bytes;
- `BOOTSTRAP_ADMIN_TOKEN` is a unique secret of at least 32 bytes;
- `ALLOW_PUBLIC_REGISTRATION=false`;
- `STORAGE_DRIVER=postgres` with a valid `DATABASE_URL` and unique 32-byte `STORAGE_ENCRYPTION_KEY`;
- `MCP_MODE` is not `mock`.

Keep both secrets in a secret manager. On an empty production store, register
the first administrator from a trusted machine with the bootstrap header:

```powershell
$env:APP_ENV="production"
$env:ALLOW_PUBLIC_REGISTRATION="false"
$env:JWT_SECRET="<unique-secret-of-at-least-32-bytes>"
$env:BOOTSTRAP_ADMIN_TOKEN="<different-secret-of-at-least-32-bytes>"

$headers = @{
  "Content-Type" = "application/json"
  "X-Bootstrap-Token" = $env:BOOTSTRAP_ADMIN_TOKEN
}
$body = @{
  name = "Platform Administrator"
  email = "admin@example.com"
  password = "<unique-long-admin-password>"
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8080/api/auth/register" -Headers $headers -Body $body
```

Missing and incorrect bootstrap tokens return HTTP `403` without revealing
whether the store is empty. The handler checks the empty-store condition and
token again while holding the store write lock, preventing two concurrent
requests from both becoming the first administrator. After the first account
exists, the bootstrap header grants no privilege, and public registration
remains disabled; create Builder and Client users from the authenticated Admin
portal.

`BOOTSTRAP_ADMIN_TOKEN` remains required at future production startups so a
restored empty database cannot silently reopen an unprotected first-admin path.
With PostgreSQL enabled, the user, password hash, roles, permissions, and
refresh-session digest survive a restart.

## Restart verification

Create or update at least one record in each area you use, stop the backend normally, and start it again with the same three values:

- `STORAGE_DRIVER=postgres`
- the same `DATABASE_URL`
- the same `STORAGE_ENCRYPTION_KEY`

Then verify:

1. existing users can sign in;
2. Client workflow assignments are unchanged;
3. workflow YAML and canvas content load;
4. execution history, logs, and timelines load;
5. chat history loads;
6. the active provider still works without re-entering its API key;
7. settings and audit records remain present;
8. newly created IDs do not collide with old IDs.

## Migrations

Numbered migrations are embedded into the Go binary from `backend/internal/storage/migrations`. At startup, the backend:

1. takes a PostgreSQL advisory transaction lock and creates `schema_migrations` when absent;
2. holds the same transaction lock while checking and applying each numbered migration;
3. applies pending `*.up.sql` files in filename order;
4. records each successful version in the same transaction.

The initial migration creates the encrypted `runtime_state` table. After migrations, the process acquires a session advisory lock tied to the runtime state key and holds it for the store lifetime. A second backend writer for that state fails startup instead of overwriting the whole-state row. Down migrations are supplied for controlled manual rollback but are never applied automatically.

## Automated verification

The normal tests require no database:

```powershell
cd backend
go test ./internal/storage ./internal/repository ./internal/config ./internal/api/middlewares ./internal/api/handlers
```

They prove AES-GCM round trips, wrong-key and tamper rejection, absence of plaintext secrets, restart restoration across all major state groups, private-field preservation, counter recovery, failed-write rollback, HTTP `503` surfacing, concurrent mutation attribution, health recovery, and v1 policy normalization.

To exercise a real disposable PostgreSQL database:

```powershell
$env:TEST_DATABASE_URL="postgres://workflow:workflow@127.0.0.1:5432/workflow_test?sslmode=disable"
go test ./internal/storage -run TestPostgresStoreRoundTrip -count=1 -v
```

The integration test is skipped with a clear message when `TEST_DATABASE_URL` is unset. When enabled it applies migrations, writes ciphertext under a unique test key, reads and decrypts it, checks that the credential is absent from the stored bytes, and removes the test row.

## Cutover and recovery rules

- Choose PostgreSQL before creating records that must be retained. Memory data exists only inside the running process and there is no automatic memory-to-PostgreSQL importer.
- Alert on `/healthz` returning `503`. Mutating requests rejected with `503` were not committed and are safe to retry after storage health recovers.
- Back up the PostgreSQL database and encryption key separately. A database backup without its matching key is intentionally unreadable.
- Do not change `STORAGE_ENCRYPTION_KEY` on an existing database. Wrong keys and tampered ciphertext fail startup instead of silently resetting state. A future key-rotation tool must decrypt with the old key and re-encrypt with the new key atomically.
- Test restores against a separate database before a production cutover.
- Keep registry JSON paths on durable storage and back them up with the database.

## Current scaling boundary

The encrypted snapshot is a compatibility bridge for the existing handler API. It serializes the complete state on each mutation, serializes mutating HTTP requests for exact failure attribution, and briefly blocks readers while a snapshot is encrypted and saved. PostgreSQL enforces one writer per state key with a lifetime advisory lock. Horizontal writers, partial-record queries, high mutation throughput, and very large upload volumes require normalized PostgreSQL repositories rather than the snapshot row.
