# Native business storage correction — 17 October 2026

## Requested boundary

Store chats, ordinary business content, workflow definitions, reviewed transaction details and model response text as normal database content, not whole-record application ciphertext. Keep passwords hashed, actual credentials protected, and existing authentication/authorization/integrity controls enforced.

This is an existing **staging preview** update, not a new claim of full production qualification.

## Active databases

| Environment | Project | Active workspace |
| --- | --- | --- |
| Existing staging | `workflow-automation-44201` | `lcwe-staging-native-20261016` |
| Local emulator | `lcwe-local-erpbridge-20261016` | `hosted-bridge-local-native` |

Both active profiles explicitly select `FIRESTORE_CONTENT_FORMAT=native-fields/v1`.

The legacy `backend-ts/.env` still identifies **another project**, `low-code-42698`, and an old ERPBridge hostname. It is not the configuration used by the verified local starter or staging Functions. That separate database was not modified. Do not use that legacy profile as evidence of this deployment's storage mode.

## Actual defects corrected

1. Background chat requests and saved revision context still created complete AES-encrypted copies even when the database itself used native fields. Native mode now writes `inputFields` and `revisionContextFields` instead. Completed/cancelled jobs erase captured execution input, including provider configuration.
2. A large business record containing a credential fell back to whole-record encryption. Credentials are now sealed individually before chunking; the remaining business content stays unencrypted.
3. Server-only model receipts still encrypted normal response text in `resultCiphertext`. Native mode now uses `resultFields`, with the same bounded receipt budget and public-DTO exclusion.
4. Business journals with historical names ending in `Secret` were indiscriminately encrypted as credentials. Model, transaction, approval, publication and report journals now remain native; nested actual credentials remain sealed. Old encrypted journal wrappers still decode correctly.
5. Queued workflow-read inputs now use native fields in native mode. The worker lease's authentication tag binds those exact fields, and the worker checks their business content against the published execution snapshot. Legacy ciphertext remains readable; terminal cleanup erases both formats.

No permission, ERP token restriction, transaction approval, idempotency or no-blind-retry rule was removed. ERPBridge, RAG and pipeline source/deployments were not changed.

## What is still protected — deliberately

- Passwords remain hashed. Provider keys, ERP tokens, login/session credentials and credential records remain protected and server-side.
- Internal dispatch/lease credentials, private provider continuations, protected recovery envelopes and small atomic storage-control metadata retain their existing protection. This is **not** a removal of all cryptography from the application.
- Historical immutable versions and private rollback backups are retained. Looking at an inactive backup, an old workspace or an encrypted manifest is not the same as inspecting current business content.
- `STORAGE_ENCRYPTION_KEY` remains required for credentials, integrity addressing and legacy compatibility. Removing or rotating it without a migration would make existing records unreadable.

## Where to inspect business content

Current business chunks are under:

`workspaces/<active-workspace>/lcwe_runtime/head/lcwe_record_chunks/<chunk-id>`

Ordinary native records expose `data.record.value`. Deep JSON may use readable `data.json`; large records use bounded encoded segments. Base64 is encoding, not encryption. A native chunk's 32-byte `payload` is an HMAC integrity tag, not encrypted business content.

The `lcwe_private_records` collection name is historical. It contains authenticated record manifests and plaintext query indexes, not the chat body itself. Frontend access still goes through the authenticated backend; plaintext storage does not mean public browser/database access.

## Existing data conversion

- Local: converted **15** older saved request contexts; readback verified; no active chat job existed.
- Staging: converted **29** older saved request contexts; readback verified; no active chat job existed.
- All original messages, workflows, users, roles, credentials, outcome journals and unrelated repository state were preserved.
- A separately encrypted private backup was verified before each non-empty database conversion. No old workspace or immutable chunk was purged.
- Follow-up model-receipt conversion and final deployment checks are recorded in the evidence files below.

## Verification

- Latest expanded backend regression: **5,326 passed, 0 failed, 1 skipped** (262 suites).
- Full frontend regression: **1,256 passed, 0 failed** (142 suites).
- TypeScript typecheck passed.
- Functions build and seven-export artifact verification passed.
- Hosting build and project-bound artifact verification passed.
- Public artifact credential scan passed.
- All three staging pagination indexes were confirmed **READY**; no index deletion was performed.
- Local real Qwen conversation, hosted-ERPBridge stock read and saved, unpublished create-item proposal were verified. No ERP write was dispatched.
- Actual local browser revision of an older, converted request succeeded and retained original history.
- Actual staging browser chat list initially loaded 20 conversations; loading the next page displayed all 23 existing conversations.

The first staging message-pagination harness incorrectly expected an unchanged 45-message fixture. Live inspection found **47** messages, because two real test messages had been added earlier. The harness was corrected to validate the actual stored total, bounded page sizes and unique IDs. Its original failed result was retained.

## Evidence files

- `tmp/local-performance-20261016/native-journals-backend-full-20261017.json`
- `tmp/local-performance-20261016/native-content-frontend-full-20261017.json`
- `ops/deployment/firebase/native-chat-normalization-local-apply-20261017.local.json`
- `ops/deployment/firebase/native-chat-normalization-staging-apply-20261017.local.json`
- `ops/deployment/firebase/native-chat-normalization-staging-apply-followup-20261017.local.json`
- `ops/deployment/firebase/current-native-storage-local-followup-20261017.local.json`
- `ops/deployment/firebase/current-native-storage-staging-followup-20261017.local.json`
- `ops/deployment/firebase/native-content-release-verification-followup-20261017.local.json`
- `ops/deployment/local/native-inventory-draft-followup-20261017.local.json`
- `ops/deployment/local/native-request-revision-ui-20261017.png`

Release controls pause only the four existing task queues and two schedulers during the mixed-version worker rollout, then restore their exact prior states. Public permissions, secrets and ERP deployments are not changed by those release controls.

## Final hosted follow-up

The hosted current-record audit at 01:42 UTC on 17 October verified 818 native business chunks, five protected credential chunks, zero protected whole-business chunks, zero legacy request fields, zero encrypted model receipts and zero encrypted read inputs. Older immutable versions/backups were excluded and were not deleted.

The later natural-chat release updated all seven workers, verified their matching source and private invocation permissions, and restored all four queues and both schedulers. Its real hosted ERP lookup, confirmed synthetic update and fresh readback passed. See `reports/NATURAL_ERP_CHAT_2026-10-17.md` for the newer release and acceptance evidence. This does not qualify every external service or a complete production release.
