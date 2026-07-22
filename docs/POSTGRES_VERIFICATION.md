# PostgreSQL Persistence Verification

Date: 2026-07-22

Verdict: **WORKS**

The PostgreSQL storage implementation was exercised against a real PostgreSQL 18 server. Both previously skipped storage integration tests ran and passed. API-created identity, workflow, assignment, and provider state survived a backend stop/start cycle. The database stored one encrypted runtime snapshot, and neither the test provider credential nor the administrator email appeared in plaintext. No storage-layer defect was revealed, so no application code changed in Part A.

## Environment note

The prescribed Compose command was run:

```powershell
docker compose -f backend\docker-compose.yml up -d postgres
```

It failed before container creation because Docker Desktop's Linux engine pipe was absent:

```text
unable to get image 'postgres:16-alpine': error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.48/images/postgres:16-alpine/json": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.
```

Docker Desktop reported `Status stopped`. Starting its WSL distribution failed because its backing disk path was missing with `ERROR_PATH_NOT_FOUND`. Docker was not reset because a reset could destroy unrelated local Docker state.

PostgreSQL 18 was already installed on the machine. To avoid changing the user's existing PostgreSQL service, the verification used a new isolated cluster under a temporary directory, bound only to `127.0.0.1:55432`:

```powershell
initdb -D [TEMP_DIR] -U workflow -A trust --no-locale --encoding=UTF8
pg_ctl -D [TEMP_DIR] -l [TEMP_LOG] -o "-p 55432 -h 127.0.0.1" -w start
createdb -h 127.0.0.1 -p 55432 -U workflow workflow
```

Startup evidence:

```text
The database cluster will be initialized with locale "C".
Data page checksums are enabled.
creating configuration files ... ok
performing post-bootstrap initialization ... ok
syncing data to disk ... ok
server started
```

This is a real PostgreSQL engine, not a mock or in-memory substitute. The fallback differs only in provisioning method from `backend/docker-compose.yml`.

## Runtime configuration

The following variables were exported for the live tests and server run. The encryption-key value is intentionally not printed.

```text
DATABASE_URL=postgres://workflow@127.0.0.1:55432/workflow?sslmode=disable
TEST_DATABASE_URL=postgres://workflow@127.0.0.1:55432/workflow?sslmode=disable
STORAGE_ENCRYPTION_KEY=[REDACTED: generated 32-byte key, base64 encoded]
STORAGE_DRIVER=postgres
```

The server applies embedded migrations when it opens PostgreSQL (`backend/internal/storage/postgres.go`). The storage integration test opened the database first, which ran migration 1.

## Migration proof

Command:

```powershell
psql $DATABASE_URL -c "\dt"
```

Output:

```text
                List of tables
 Schema |       Name        | Type  |  Owner
--------+-------------------+-------+----------
 public | runtime_state     | table | workflow
 public | schema_migrations | table | workflow
(2 rows)
```

Migration record:

```sql
SELECT version, applied_at IS NOT NULL AS applied
FROM schema_migrations
ORDER BY version;
```

```text
 version | applied
---------+---------
       1 | t
(1 row)
```

## Previously skipped integration tests

Command:

```powershell
$env:TEST_DATABASE_URL=$DATABASE_URL
go test ./internal/storage -run 'TestPostgresStore(RoundTrip|EnforcesSingleWriterPerStateKey)' -count=1 -v
```

Output:

```text
=== RUN   TestPostgresStoreRoundTrip
--- PASS: TestPostgresStoreRoundTrip (0.15s)
=== RUN   TestPostgresStoreEnforcesSingleWriterPerStateKey
--- PASS: TestPostgresStoreEnforcesSingleWriterPerStateKey (0.16s)
PASS
ok  github.com/sanjeewa/agentic-orchestrator/internal/storage  1.469s
```

Both tests ran; neither emitted `SKIP`.

The round-trip test proves write/read equality, successful AES-GCM decode, and absence of its provider credential from the stored payload. The single-writer test proves a second writer cannot acquire the same state key, the advisory lock releases on close, and a later writer can reacquire it.

## API restart-persistence proof

The backend was started from `backend/` with the PostgreSQL variables above and `APP_HOST=127.0.0.1`, `APP_PORT=18080`, and `APP_ENV=development`:

```powershell
go run -buildvcs=false ./cmd/server
```

Startup output:

```text
storage initialized  {"driver": "postgres", "durable": true}
agentic orchestrator backend listening  {"addr": "127.0.0.1:18080", "api": "/api"}
```

The following operations used the public/protected API routes, not direct SQL inserts:

| Operation | HTTP result | Sanitized result |
|---|---:|---|
| Register first account | 201 | `usr_1`, role `Platform Admin` |
| Login | 200 | access token issued; token not printed |
| Create workflow | 201 | `wf-7eb98f1f`, `PostgreSQL Restart Proof` |
| Create client user | 201 | `usr_5`, role `Client` |
| Assign workflow to client | 200 | assignment contains `usr_5` |
| Create Gemini provider config | 201 | `provider_8`, active; response has `keyPreview` and no `apiKey` |

Captured sanitized creation result:

```json
{"registrationRole":"Platform Admin","loginTokenIssued":true,"adminId":"usr_1","workflowId":"wf-7eb98f1f","workflowName":"PostgreSQL Restart Proof","userId":"usr_5","userRole":"Client","assignmentContainsUser":true,"providerId":"provider_8","providerFields":["id","name","type","model","keyPreview","active","createdAt"],"providerHasApiKey":false,"providerHasKeyPreview":true}
```

The server process was then stopped. A new server process was started with the same database URL and encryption key. Its startup again reported `driver=postgres` and `durable=true`. A new login succeeded using the persisted password hash, followed by API GETs for the workflow, user, and provider list.

Captured sanitized post-restart result:

```json
{"restartLoginSucceeded":true,"adminId":"usr_1","workflowId":"wf-7eb98f1f","workflowName":"PostgreSQL Restart Proof","workflowAssignmentSurvived":true,"userId":"usr_5","userEmail":"client@part-a.test","userRole":"Client","providerId":"provider_8","providerModel":"gemini-2.5-flash","providerActive":true,"providerFields":["id","name","type","model","keyPreview","active","createdAt"],"providerHasApiKey":false,"providerHasKeyPreview":true}
```

The second process was stopped after the GET proof.

## Encryption-at-rest proof

This implementation intentionally uses an encrypted aggregate snapshot, not normalized `users`, `workflows`, or `provider_configs` tables. Therefore the requested `SELECT api_key FROM provider_configs` is not applicable: `provider_configs` does not exist. The equivalent proof inspected the `runtime_state.payload` bytes without printing the credential or the payload.

Sanitized query result:

```text
 state_key | encrypted_bytes | provider_key_not_plaintext | admin_email_not_plaintext |    ciphertext_prefix
-----------+-----------------+----------------------------+---------------------------+--------------------------
 default   |            8968 | t                          | t                         | 4c4357455f53544154455f56
(1 row)

 provider_configs_table_absent | encrypted_snapshot_rows
-------------------------------+-------------------------
 t                             |                       1
(1 row)
```

The displayed prefix is the non-secret `LCWE_STATE_V...` envelope marker. The body is AES-256-GCM ciphertext. The API-side proof independently showed that provider responses contain `keyPreview` but not `apiKey` both before and after restart (`backend/internal/api/handlers/provider_handler.go:20-29`, `:172-176`).

## Memory-mode and safety regression

The full suite ran with `STORAGE_DRIVER=memory` and the live `TEST_DATABASE_URL`, so the application exercised its memory default while the two storage integration tests also ran:

```powershell
$env:STORAGE_DRIVER='memory'
$env:TEST_DATABASE_URL=$DATABASE_URL
go test ./... -count=1
```

Result: exit 0. All 13 packages containing tests reported `ok`, including `internal/storage`; no package failed. The final package was:

```text
ok  github.com/sanjeewa/agentic-orchestrator/tests/unit  95.389s
```

Focused invariant command:

```powershell
go test ./... -run 'Dispatch|Deferred|Token|WritePaths|StrictGate|Threshold' -count=1 -v
```

Result: exit 0. The passing set included:

```text
TestWorkflowWritePathsRejectInvalidDefinitionsWithoutPersistence
TestDispatchViolationMarksExecutionFailedWithoutHealing
TestUnknownYAMLFieldRejectedByStrictGate
TestRegistryMutationPersistsSwapsHashRejectsOldTokenAndAudits
TestRunnerRejectsMissingOrMismatchedValidationTokenWithoutExecution
TestLiteralOverThresholdRejectedAtPlanTime
TestDeferredThresholdDispatch
TestBaselineBExecutesDispatchViolationAndAuditsBypass
TestBaselineBBypassesMissingTokenWhileDefaultStillBlocks
TestDeferredRequiredParameterRevalidatedAtDispatch
TestDeferredCheckWithoutEvaluatorFailsClosed
```

The experiment was written to a temporary directory outside the repository so measured latency did not alter committed thesis artifacts:

```powershell
$env:APP_ENV='experiment'
go run -buildvcs=false ./cmd/run-experiment -output [TEMP_OUTPUT_DIR]
```

Output:

```text
cases=120 rows=240
MODE      TP  FP  TN  FN  RECALL  PRECISION  FNR     F1
gate_on    54   0  60   6  0.9000  1.0000     0.1000  0.9474
gate_off    0   0  60  60  0.0000  0.0000     1.0000  0.0000
Known caveat: The 6 unsafe self_approval cases are ground-truth false-negative probes because no enabled separation_of_duties rule exists; they remain false negatives when gate-on allows them.
REGRESSION_METRICS_OK
```

The required confusion-matrix counts and derived metrics did not move.

## Final disposition

- PostgreSQL migrations: **verified**.
- Encrypted save/load round trip: **verified**.
- Single-writer advisory lock and release: **verified**.
- API-created user/workflow/assignment/provider survival across server restart: **verified**.
- Provider credential absent from database plaintext and absent from API responses: **verified**.
- Memory-mode regression: **verified**.
- G1/G2 focused regression: **verified**.
- Experiment metrics: **unchanged**.
- Docker Compose provisioning on this workstation: **environment-blocked** by a missing Docker Desktop WSL backing disk; the real-database proof used isolated local PostgreSQL instead.

No secret value is included in this document.
