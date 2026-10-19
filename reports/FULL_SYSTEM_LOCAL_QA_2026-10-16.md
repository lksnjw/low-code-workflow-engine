# Local full-system QA — 16 October 2026

## Outcome

**Core local integration verified; not fully ready for an AI/RAG demonstration.**

The updated standalone ERPBridge, low-code frontend/backend, document pipeline, RAG service and local databases were started and tested. Two low-code defects were reproduced, fixed and regression-tested. A saved, published 12-node workflow completed twelve real HTTP ERP reads through the updated bridge using a personal user token. Document indexing and retrieval also worked through that bridge.

Successful natural-language chat, model-generated workflow edits and semantic RAG policy answers remain blocked by expired model-provider credentials (HTTP 401). The full pipeline suite is not green because several integration fixtures are absent, plus three test-environment limitations. Remaining UI discrepancies are documented below, not silently marked passed.

This is local evidence, not a hosted deployment or production qualification. No cloud database migration/deployment, ERP business-record write, email delivery or schedule activation was performed. Business data and uploaded documents used for this run were synthetic. The successful 12-node workflow uses deterministic execution; it is not evidence of successful AI generation or runtime model analysis.

## Components and exact checkouts

| Component | Checkout / runtime | Result |
| --- | --- | --- |
| Low-code platform | `C:\Users\LKsnj\Desktop\RESEARCH_LAKSHAN\IMPLIMENTATION\low-code-workflow-engine` | Backend/frontend tests and builds pass; two fixes below |
| Updated ERPBridge | `C:\Users\LKsnj\Desktop\RESEARCH_LAKSHAN\IMPLIMENTATION\bridge\ERPBridge`, commit `78e1b5b`, v0.5.0-alpha.6 | Tested and built from this standalone checkout, not older nested copies |
| Pipeline | `DATA_TRANSFORM\erp-data-transformation-pipeline` under the low-code checkout, HEAD `ebc259f` plus existing local changes | Targeted new features and live scenarios pass; full-suite fixture gaps remain |
| RAG | `C:\Users\LKsnj\Desktop\RESEARCH_LAKSHAN\IMPLIMENTATION\R26-SE-034\FineTuneModel\Rag\rag-system` | Live core-file hashes match checkout; deterministic checks pass, model-dependent evaluation blocked |

The workspace already contained extensive uncommitted changes. They were preserved. ERPBridge, RAG and pipeline source were not changed by this QA run. No commits, pushes or pull requests were created.

## Low-code repairs made

### 1. Backward-compatible Firestore snapshot loading

File: `backend-ts/src/storage/firestore-records.ts`, `checkedFirestoreState`.

Older normalized snapshots lacked the newly added `userMcpCredentials` map. The existing strict canonical equality check compared the old snapshot against its restored form, which includes an empty map, and rejected startup.

The compatibility rule now accepts **only the absence** of that new field by treating it as an empty map for comparison. Present malformed maps still fail. Unrelated normalization or authority changes still fail. This does not copy the environment token to users, grant a role, repair corrupted roles or migrate the hosted database.

Regression evidence:

- `backend-ts/tests/firestore-user-credential-upgrade.test.ts`: six acceptance/rejection cases.
- `backend-ts/tests/firestore-records.test.ts`: actual normalized legacy-state loading, next persistence and reopening.

### 2. Personal credentials inside scoped execution transactions

File: `backend-ts/src/tools/user-mcp-credentials.ts`, private `actor` helper.

Queued read admission receives a recursively read-only transaction view. The old actor lookup attempted `structuredClone` on a proxied user record, producing `DataCloneError` and HTTP 500. Actor lookup now reads and validates only the required identity/status/role scalar values. It does not unwrap the transaction or relax unrelated-write protection.

Regression evidence: `backend-ts/tests/user-mcp-credentials.test.ts` verifies successful binding through the execution-transaction view while unrelated writes remain rejected. The twelve-step live workflow subsequently completed.

The personal-credential source/test files already belonged to the in-progress feature and are untracked in this checkout; the limited repair above must not be confused with creating that entire feature during this QA run.

## Automated verification

| Area | Result | Qualification |
| --- | --- | --- |
| Low-code backend full suite | **5,219 passed; 0 failed; 1 skipped; 210 test files** | Final clean full run after both repairs, maxWorkers=2 |
| Low-code frontend full suite | **1,246 passed; 141 suites** | Component/unit tests, supplemented by live UI checks below |
| Backend TypeScript typecheck | Passed | After both repairs |
| Backend production build | Passed | Local build only |
| Functions build and artifact verification | Passed | Seven exported entrypoints; partial Functions adaptation is not full production acceptance |
| Frontend production build | Passed | Rebuilt after final UI checks |
| Updated ERPBridge, isolated Linux Go suite | **804 passing test/subtest events; all packages pass** | 15 tested packages plus 4 packages without tests; subtest count is not 804 independent integration scenarios |
| Pipeline full suite | **3,640 passed; 26 failed; 15 errors; 276 skipped** | Breakdown below; not an all-green result |
| Pipeline collection-routing/document-workspace suites | **45 passed** | Targeted new feature coverage |
| RAG deterministic corpus/rule checks | **8 passed** | Actual indexed policy corpus, without an LLM |
| RAG coverage and clause-chunk checks | Passed | 48 indexed chunks; these checks alone do not establish end-to-end semantic correctness |
| RAG retrieval-only golden evaluation | Blocked/failed | Embedding provider returns HTTP 401 |

An earlier backend run during cold Docker/Go startup had two timing failures. Both affected suites passed independently and the final full run above had zero failures; the final result supersedes that earlier run.

### Pipeline full-suite failure analysis

**38 cases (23 failures and 15 setup errors)** require missing files under `tests/erp_pipeline/integration/fixtures/`:

- `member1_allow.json`
- `member1_deny.json`
- `member1_allow_with_conditions.json`
- `member2_employee_response.json`
- `member2_error_response.json`
- `member2_invoice_response.json`
- `member2_collection_response.json`

That directory was absent in this checkout; Git tracked-file/history lookup did not find those fixture files. They were not fabricated to turn the suite green.

The remaining **three failures** were test-environment issues:

1. OpenAPI snapshot generation attempted to write into the read-only source mount. The same test passed when rerun with a separate writable artifacts mount; the repository snapshot was not changed.
2. Two repository-hygiene tests require the `git` executable, which is absent from the runtime image. Equivalent real-host `git check-ignore` checks passed: the public OpenAPI snapshot is not ignored, while `.env`, raw data, uploads and cold archives are ignored.

Required next step: restore the intended seven fixtures and provide a test image with Git and writable test artifacts, then rerun the unmodified full suite. Do not report 41 confirmed application defects, or claim the full pipeline suite passed.

### ERPBridge native Windows test caveat

Native Windows `go test ./...` did not pass. Failures included Unix-path/executable assumptions, SQLite file-lock cleanup, and HOME-based isolation that does not isolate `os.UserHomeDir()` on Windows (which uses USERPROFILE).

**Observed side effect:** native CLI tests rewrote the user's `C:\Users\LKsnj\.bridgectl\config.yaml` to a fixture `test` context/server. An observed copy was preserved privately at `tmp/full-system-qa-20261016/windows-cli-test-config-observed.yaml`. The original content was not available, so no guessed restore was performed. Review/reselect the intended bridgectl context before using that CLI. This is separate from the low-code app's configured bridge connection.

The clean bridge result was obtained in an isolated Linux container as non-root UID 1000, copying the checkout into writable tmpfs, with the original source mounted read-only. Running tests as root or on a read-only working copy produces misleading fixture/permission failures, so those initial harness attempts were not used as the final result. Bridge source was not patched to mask Windows failures.

## Live integration scenarios

### Platform / updated bridge: 7 checks passed

1. Backend durable Firestore-records storage and pipeline dependencies report healthy/ready.
2. A real bridge-issued personal token saves encrypted through self-service, is not echoed, and passes discovery-only connection testing.
3. The updated bridge advertises exact revision tool names with `MCP_ADVERTISE_REVISION_ALIASES=true`.
4. A separate comparison instance confirms default discovery hides revision aliases while pinned calls still work.
5. Three document-library read contracts were reviewed only in the isolated local QA workspace.
6. Workflow `wf_251_81635a6a` saved, published as v1 and completed execution `run-d9c265175001c7ea`: **12 confirmed ERP read steps, 0 ERP writes**.
7. A real RAG request traversed ERPBridge and returned a structured fail-closed denial when its model credential was rejected.

Check 7 proves routing and safe failure handling, **not** successful RAG policy reasoning: the response had zero retrieved chunks/citations and reported `OpenAIAuthenticationError`.

### Pipeline / document library: 9 checks passed

1. Two entity schemas produce four distinct destinations before document upload: standard/restricted collections for Employees and Customers. Catalog summaries contain no extracted private content.
2. A TXT registration creates a reviewed pipeline database record and real vectors in the employee standard collection.
3. A PNG synthetic medical note is OCR-extracted and routed to the restricted employee collection with no shared-reader roles.
4. A text PDF registration indexes into the separate customer collection.
5. A valid XLSX spreadsheet uploads and extracts into REVIEW; no automatic bulk ERP creation is claimed.
6. The agent catalog through ERPBridge reports current per-collection counts without revealing private fields.
7. Semantic library search and exact document resolution through ERPBridge retrieve stored reviewed content.
8. Retrieval without signed caller delegation is denied.
9. Updating the registration to version 2 updates the same pipeline record and does not inflate the current-document count.

Collection routing is by source system/entity schema plus a separate restricted destination, not one shared vector collection for everything. The schema/catalog guides routing; the server still enforces allowed destinations, ownership and sensitivity. Vector storage does not itself create an ERP employee/customer. The TXT test created a pipeline record; an ERP write remains a separate reviewed API operation.

Initial retrieval failures in the newly created QA bridge container came from its missing `ERP_DATA_TRANSFORMATION_API_KEY` downstream credential. Correcting that isolated container's configuration fixed retrieval without pipeline source changes. The initial XLSX test fixture lacked valid cell references and was corrected; the service correctly rejected that invalid fixture.

### Personal credentials and role isolation: 5 checks passed

1. Non-admin self-service can manage only the current user's connection; injected owner identity is rejected, and admin settings remain forbidden.
2. A global workflow reader cannot read another owner's private chat (404).
3. A real least-privilege bridge token can connect without acquiring management/admin access: management HTTP 403, forged admin role on a guarded library tool denied.
4. Revoking a token remotely blocks an already initialized MCP session.
5. Removing one's own saved token leaves another user's credential intact; subsequent use of the removed credential is denied.

These tests cover the named role/permission variations, not every theoretical role combination. The environment credential is for catalog/review; business execution uses the authenticated user's personal token. A local role label cannot elevate the remote token's permissions.

## Live browser checks

Tested in the real local application at `http://127.0.0.1:5195`, not only via component tests:

- Stale session redirects to sign-in; a known local test user can log in.
- Login and message submission show loading/disabled states while pending.
- A restored 65-message conversation pages from 30 to 60 messages, then loads the last five at the top; the final state says all earlier messages loaded.
- Keyboard resizing changes the chat/canvas split; canvas-only mode offers floating chat; opening/minimizing floating chat and Reset layout work.
- The saved twelve-node workflow appears in the list with its completed run; its canvas shows twelve steps and returned records.
- Edit in chat opens an editing conversation with the selected workflow retained.
- A harmless manual label edit goes through Preview -> Apply to draft -> revision 2; reload confirms persistence. Publication/execution remain separate. The previous completed execution stays on published v1 and retains the original node labels.
- The execution detail shows Done, real returned ERP records and twelve DONE timeline entries.
- Asking for an explanation did not automatically run or edit the workflow, but did not produce a useful explanation because model intent classification was unavailable (open issue below).

Continuation checks after restarting the local processes:

- Imported today's saved emulator export into a newly started Firestore process; the healthy backend, personal credential, completed twelve-step run and draft revision 2 were all retained (six API checks passed).
- Personal-token UI connection testing passed against the updated bridge, with pending controls disabled and the stored token value never shown.
- Settings visibly has two independent controls: RAG policy checker through ERPBridge, and local JSON policy agent. Both were Off. They were inspected, not toggled to weaken or change saved policy.
- Document inventory UI shows the employee/customer standard and restricted destinations, permitted counts and ownership/sharing explanations. Malformed schema JSON produces a visible parse error without saving.
- Independent reviewer login shows only permitted navigation, denies the upload workspace and direct access to the owner's chat, and shows **No personal token** instead of inheriting the owner's/admin token.
- After startup reconnection, draft v2 passes validation and bridge discovery is available. It remains unpublished (`can_attempt_run=false`), while the historical v1 execution remains Done. No publication or new execution was performed.

Screenshots:

- `reports/full-system-qa-20261016-completed-run.png`
- `reports/full-system-qa-20261016-floating-chat.png`
- `reports/full-system-qa-20261016-restored-run.png` (execution after fresh emulator import)

### Open UI / readiness issues

1. **Misleading standalone preview header:** the read-only full canvas preview labelled the workflow Draft/readiness unchecked with zero success counts while the detail page had a published, completed execution. Preview nodes being idle can be appropriate; presenting the publication state as Draft is confusing. No frontend repair was made in this narrowly approved backend compatibility change.
2. **Poor intent-provider failure guidance:** the prompt “What does this workflow do? Explain its steps. Do not run or change anything.” received “I couldn't reliably identify your request...” rather than a clear model-provider authentication failure. The saved reply/no-tool behavior is safe, but not acceptable evidence of natural conversation working.
3. **Capability fence observed after the first QA bridge restart:** the canvas reported Published/blocked and that the artifact needed current capability review and explicit republication. The recorded v1 execution remained Done. On the continuation startup the local QA harness reconnected/reviewed the already scoped test capabilities; latest readiness reports discovery available, valid draft v2, but the edited draft remains unpublished and cannot execute. It was not automatically published or run. Historical success is not a claim of current unconditional run readiness.

No claim is made here that all chart types, email delivery, ERP writes, human approval outcomes, schedules, automatic model-generated workflows or every UI button were successfully exercised live in this run. Automated coverage is not a replacement for those missing provider-dependent scenarios.

## RAG-specific findings

- The real policy collection contains 48 indexed chunks.
- Current-policy filtering excludes superseded `FIN-AP-2023-011`; mandatory/action authority clauses remain present.
- Deterministic checks cover self-approval denial, unknown segregation, unmet over-threshold conditions, missing amount and missing role.
- Coverage and clause-chunking checks pass, including intact clause 3.2. Keyword coverage alone is not proof of policy-decision accuracy.
- Both saved low-code provider credentials and the RAG embedding/model credential tested here returned HTTP 401. No replacement has been supplied privately yet.
- RAG logs warn that qdrant-client 1.19.1 and Qdrant server 1.15.4 exceed the recommended minor-version compatibility window. Current corpus/filter checks pass, but dependency alignment remains a follow-up risk.

Required: update valid provider credentials directly in the appropriate local app/private environment, then rerun semantic retrieval, grounded policy allow/review/deny cases, natural explanations and model-authored workflow edits. Never paste provider keys into this report, chat, screenshots or Git.

## Local service locations

| Service | Local address |
| --- | --- |
| Web app | `http://127.0.0.1:5195/` |
| Backend API | `http://127.0.0.1:18092/api` |
| Updated QA ERPBridge, revision compatibility enabled | `http://127.0.0.1:18090/mcp/` |
| Default-discovery comparison bridge (stopped after comparison) | `http://127.0.0.1:18094/mcp/` |
| Isolated business ERP | `http://127.0.0.1:18091/` |
| Document pipeline | `http://127.0.0.1:8000/` |
| RAG | `http://127.0.0.1:18000/` |
| Firestore emulator | `127.0.0.1:23671`, project `demo-lcwe-records` |

PostgreSQL, Qdrant and Redis run in their local Docker networks. The bridge test database is a clone; the original stopped bridge database was not overwritten. The comparison bridge is separate. None of these checks changed the hosted service at `erpbridge.nimendra.online` or the deployed frontend/backend.

## Evidence and persistence

Safe result summaries under `tmp/full-system-qa-20261016/`:

- `backend-tests.json`
- `bridge-tests.jsonl`
- `pipeline-tests.xml` and `pipeline-tests.log`
- `live-results.json` (7 checks)
- `pipeline-live-results.json` (9 checks)
- `role-live-results.json` (5 checks)
- `ui-live-results.json` (live UI findings)
- `post-restart-results.json` (6 restore/readiness checks)
- `rag-deterministic-check.py` (test definition; execution observed in the container)

Harness commands include backend `npm test -- --maxWorkers=2 --reporter=json --outputFile=../tmp/full-system-qa-20261016/backend-tests.json`, frontend `npm test` / `npm run build`, isolated Linux `go test -json ./...`, and pipeline pytest. Harness scripts create synthetic local test data and some credentials; do not rerun or publish them without reviewing their effects.

Local Firestore data was exported to `tmp/full-system-qa-20261016/emulator-export/`. The CLI hub export reported no exportable emulators despite Firestore being healthy; the documented Firestore emulator export endpoint succeeded directly, and metadata was added for that existing export. During the continuation, a fresh Firestore process successfully imported that export and six restore/readiness checks passed. This private export contains application state and must remain ignored/unpublished. `session.json`, runtime/private configuration and the observed CLI config are also not public evidence.

## What is needed to close the remaining QA

1. Valid low-code model and RAG embedding/model credentials, entered privately.
2. Restore the seven intended pipeline integration fixtures and rerun in a suitable test image.
3. Keep `MCP_ADVERTISE_REVISION_ALIASES=true` for this low-code discovery implementation, or separately implement/test discovery compatible with the new bridge default. Do not remove revision pinning to bypass review.
4. Explicitly publish/review the edited QA draft before any new execution. Reconnection/discovery was reverified during the continuation; draft v2 is intentionally still unpublished.
5. Correct preview publication wording and model-failure guidance, with frontend/backend regression and live UI checks.
6. Check the Windows bridgectl context affected by the native test-isolation issue before subsequent CLI use.

Until these are closed, describe the result as **verified local deterministic workflow/document integration with remaining model, fixture and UI issues**, not a fully finished AI-enabled deployment.
