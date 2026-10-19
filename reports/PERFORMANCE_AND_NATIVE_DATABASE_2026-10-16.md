# Performance and native database release - 16 October 2026

Status: deployed and verified in the existing limited staging preview. Native database cutover completed on 16 October 2026; this is not full production qualification.

Target: the existing limited staging preview in project `workflow-automation-44201`. ERPBridge, RAG and the document pipeline remain separately deployed components and are not changed by this release.

## Approved data handling

The user explicitly selected: **credentials only protected; chat and business content stored as normal database fields**.

- Ordinary small business/chat records use `firestore-native/v1` with structured readable fields.
- Provider keys, tokens, authorization values and other recognized credential fields are individually AES-GCM protected. Credential domains (API keys, refresh sessions, personal ERP credentials and password hashes) remain private records. Passwords remain hashed; no plaintext-password storage is introduced.
- Internal secret continuations and integrity/lease metadata retain their protection. Large credential-bearing records retain the protected representation; large or deeply nested business values use bounded JSON/chunk representations to respect Firestore limits.
- Native business packets are authenticated with an HMAC. The authoritative head, manifest membership, writer fencing, scope checking, checkpoint acknowledgement and role checks remain enforced. Plaintext is not permission to trust modified metadata.
- Browser access is still through the authenticated backend; no direct browser access to database collections is introduced.
- Database administrators/backups can now read ordinary chat/business content. This is the requested privacy tradeoff, not a claim that business content is insensitive.
- Google-managed encryption at rest remains enabled. It is separate from application-level record encryption. [Firestore server-side encryption](https://docs.cloud.google.com/firestore/native/docs/server-side-encryption).

## Measured baseline

These are single local-client observations against the deployed API, not statistical p95/SLA results.

| Request | Decoded response | Observed total |
| --- | ---: | ---: |
| Current user | 658 bytes | 1,960 / 1,984 ms |
| Model catalogue | 423 bytes | 1,468 ms |
| First chat-list page | 3,817 bytes | 2,420 ms |
| Recent conversation | 3,345 bytes | 1,321-1,672 ms |
| Workflow list | 17,446 bytes | 2,319 ms |

The small payloads show that transfer size alone did not explain the delay. Profiling found 677 logical records and 967,092 decoded bytes in the staging workspace. A local-client full authenticated database load took 7,563 ms; conversion/strict reconstruction took roughly 170 ms combined, and decoding 1,000 synthetic 1 KiB records took approximately 95 ms. These phases include different work and are not a pure encryption/network decomposition.

## Changes

1. New workspaces do not automatically open the latest saved conversation. The user chooses a saved chat or starts a new one.
2. Conversations request the latest 20 messages and load earlier history 20 at a time. Backend paging occurs before cloning large artifacts. Older workflow identities remain available independently of the message page.
3. Workflow lists now have real bounded pagination, newest-first order and Previous/Next controls. Filtering precedes pagination. Workflow execution summaries use a grouped lookup rather than rescanning all runs for each workflow.
4. Existing TanStack Query is used for an account-scoped shared model catalogue. Model selection/drafts remain conversation-specific. Route-level code splitting was already present and is retained.
5. Duplicate recurring operation-list polling is removed while the cursor progress monitor handles an admitted operation. Explicit saved-progress/conversation refresh remains available.
6. Account, chat-list, workflow-list, notification-list and saved-progress reads do not initialize MCP/model services or take an exclusive application writer merely to display data.
7. Bounded parallel Firestore chunk reads stay inside one coherent read-only transaction. Started reads are drained on failure.
8. Warm-process reuse is limited to read-only storage clients and verified images. Every snapshot authenticates a fresh committed head; a changed head reloads data. No writable repository or authorization decision is cached between requests. A failure discards the reader, not serves stale data.
9. Native metadata queries bind to the exact image that authorized their request, including concurrent borrowers. Owner-scoped chat history uses a database keyset cursor, not offsets, for subsequent 20-item pages.
10. HTTP API capacity is configured for 2 vCPU, 1 GiB memory and concurrency 4, with maximum 2 instances and minimum 0. Worker concurrency, private IAM, approval and idempotency rules remain unchanged. Active API instances cost more than the previous smaller configuration; no always-on minimum was added.

## Actual database indexes

All three composite indexes were read back as **READY** on 16 October 2026. No pre-existing indexes were deleted.

- Kind + updated date descending + stable identity.
- Kind + owner + updated date descending + stable identity.
- Kind + chat identity + message sequence descending.

Definitions: `backend-ts/firestore.indexes.json`. The large business-data field is exempted from automatic field indexing; intentional metadata indexes remain enabled. Sorting/indexing every arbitrary uploaded document field is neither implemented nor implied.

## Migration safeguards

- A verified encrypted source backup is retained privately because it contains credentials.
- The original workspace is retained, not overwritten or deleted.
- A new native-layout workspace is prepared and its reconstructed state/fingerprint compared with the exact source.
- Source writer ownership fences old-version mutations during preparation and deployment.
- Active chats, active/uncertain executions, active schedules or pending task deliveries prevent cutover.
- Only the storage workspace/content-format fields change in the runtime secret. JWT keys, credential encryption keys, ERPBridge settings, provider configuration and pipeline settings are preserved.
- Every function must be ACTIVE on the new secret, with traffic on its latest revision, before old invocations are drained and the source fence is released.

## Completed deployment and migration

- Frontend: https://workflow-automation-44201.web.app/ . The deployed HTTP 200 index exactly matches the tested project-bound Hosting artifact (86 public files), version `sites/workflow-automation-44201/versions/1db63d161042f61b`.
- Backend health: https://asia-south1-workflow-automation-44201.cloudfunctions.net/api/healthz (HTTP 200).
- All seven functions are ACTIVE, use `LCWE_RUNTIME_CONFIG` version **3**, and route traffic to their latest revisions. The API configuration was read back as 2 vCPU, 1 GiB, concurrency 4, maximum 2 instances and minimum 0.
- The active workspace is `lcwe-staging-native-20261016`, using `FIRESTORE_CONTENT_FORMAT=native-fields/v1`. Administrator ERPBridge credentials remain server-only; live profile readback returns no token or ciphertext.
- The source `lcwe-staging-20261016` at revision **554**, containing **677 logical records**, is retained. An encrypted private backup was verified. Source and reconstructed target matched semantically and by record fingerprint before cutover.
- The migrated record-body inventory contains **673 native business-data packets** and **4 protected credential/oversized-secret packets**. These are body-packet counts, not the total number of physical Firestore documents; protected integrity/control metadata remains present.
- Initial bulk preparation exceeded the default writer lease and stopped before activation. Migration-only target preparation was changed to the already qualified maximum 300-second lease and then verified successfully. Normal API/worker lease settings were not expanded. The old source fence was released only after all functions were active on version 3 and old invocations were drained.
- Only the API edge is public. All six other functions remain private; the four task workers have explicit runtime-identity invocation bindings. No Owner/Editor role was added. An inherited project-level Editor binding existed before this release, so this is not a full least-privilege qualification.
- ERPBridge, RAG and pipeline source/deployments are unchanged. The hosted pipeline remains explicitly unconfigured, as requested previously.

## Measured deployed improvement

Single observations from the same local-client diagnostic, in milliseconds. They include transport time and are not browser-page measurements, statistical percentiles or guaranteed latency.

| Request | Before | After |
| --- | ---: | ---: |
| Login | 4,569 | 2,163 |
| Current user, first read after login | 1,960 | 818 |
| Model catalogue | 1,468 | 123 |
| Chat list, first 20 | 2,420 | 250 |
| Recent conversation, limit 5 | 1,672 | 254 |
| Recent conversation, limit 30 | 1,321 | 542 |
| Conversation operation list | 1,560 | 129 |
| Workflow list, limit 10 | 2,319 | 133 |
| Current user, warmed read | 1,984 | 101 |
| Logout | 2,279 | 2,865 |

The measured read improvements do not mean every request improved: logout was slower in this observation. Cold initialization, authenticated writes, changed-head hydration and model/ERP network time remain. The gain cannot be attributed to removing encryption alone; read-only initialization, verified warm reuse, indexes, bounded paging and API capacity also changed.

## Verification and current limitations

Final backend regression: **5,267 passed, 0 failed, 1 skipped**. Final frontend regression: **1,251 passed, 0 failed**, across 142 suites. A final indexed-API/model-catalogue set passed 42 checks, and credential/pool checks passed 28; these overlap the suite and are not added to its totals. TypeScript checking, project-bound Hosting build/source/artifact verification, actual seven-export Functions artifact verification and all 86 public-file credential scans passed.

Real Firestore SDK/emulator acceptance passed with 124 synthetic logical records, message pages 20/20/5, newest-first checkpoint order and credential scanning. This was local storage verification, not a live ERP/provider test.

Actual deployed browser/API checks passed:

1. Opening the root starts an empty workspace instead of opening the newest saved chat. New conversation creates a distinct empty chat/canvas.
2. Chat history showed 20 of 22 conversations; loading older history showed 22 of 22. A subsequent fresh-chat creation raised the live total to 23; deployed API keyset pages were 20/3, indexed, with no duplicates.
3. A clearly labelled 45-message synthetic conversation loaded 20, then 20, then 5 messages by scrolling upward. Reload returned to the latest 20 rather than downloading the full history again. API checks independently confirmed all 45 unique messages across those pages.
4. All eight saved workflows remained listed. Page 1 of 1 displayed disabled Previous/Next controls. The saved supervisor workflow opened and its read-only canvas displayed the six decision nodes, two ERP-read nodes and five returns. This inspection did not execute it or prove a new ERP retrieval.
5. One real DeepSeek conversational request submitted through the browser completed as `ANSWERED` and was saved in `chat_244_d258ea59`, operation `chatop_245_7ec0cdd3`. Agent intent routing was `CONVERSATION`, with `toolsDispatched=false`. Admission-to-saved-reply time was **18,107 ms**, not a full browser/render time. A temporary connection warning appeared during this UI check and cleared after the explicit connection Retry; the original request was not resubmitted.
6. Live profile readback preserved the administrator-environment credential mode without exposing credentials. Deployed health returned 200 and the public index matched the exact tested Hosting artifact.

Nine explicitly synthetic pagination fixtures (one 45-message chat and eight empty chats), plus the browser-created smoke conversation, were retained for inspection. Fixture seeding made no ERP/model calls, role grants or business writes. The separate conversational smoke test made one real model request.

Screenshots: [real conversational smoke test](native-chat-hosted-20261016.png), [pagination fixture](native-pagination-hosted-20261016.png).

Native codec/storage tests cover readable content, protected credentials, wrong scope/key, tampering, metadata substitution, duplicate checkpoint acknowledgement, nested arrays, reserved/long keys, deep JSON, oversized records, keyset paging and owner isolation. Pool tests cover fresh state, scope changes, failed reads and bounded capacity.

The backend still needs an initial coherent full-image hydration on a cold reader or changed committed head. Warm unchanged-head reads avoid that work. This release is not a claim that every database operation reads only 20 documents, that all admin pages have been redesigned, or that provider/ERP network latency is eliminated.

No live ERP writes, emails, payments, business schedule activations or new role grants are part of the performance/storage migration.

## Evidence

Private ignored diagnostic artifacts are under `ops/deployment/firebase/` and `tmp/full-system-qa-20261016/`. They must not be published with credentials or private application content.

- `latency-baseline-20261016.local.json`
- `workspace-read-profile-20261016.local.json`
- `native-storage-migration-preflight-20261016.local.json`
- `native-indexes-20261016.local.json`
- `native-storage-migration-20261016.local.json` (generated by the controlled migration)
- `latency-native-after-20261016.local.json`
- `hosted-release-native-20261016.local.json`
- `native-pagination-deployed-20261016.local.json`
- `native-ui-pagination-fixtures-20261016.local.json`
- `native-storage-emulator-20261016.local.json` (under `ops/deployment/local/`)
- `native-performance-frontend-full-final.json`
- `native-performance-backend-release.json`

Earlier intermediate test failures were investigated and superseded by stable full-suite passes. A final acceptance helper initially compared Hosting with the old local development `dist` directory; it was corrected to the actual tested `.hosting/public` artifact and passed. The root-template deploy guard also correctly rejects `--base-template`; normal project-bound verification passes. Neither diagnostic mistake was a new deployed application failure.
