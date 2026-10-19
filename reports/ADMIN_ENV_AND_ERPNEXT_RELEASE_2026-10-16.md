# Administrator environment credential and ERPNext prompt release

Date: 16 October 2026. Target: the explicitly approved existing Firebase staging preview, `workflow-automation-44201`, `asia-south1`. This is not full production qualification.

## Requested behavior

- The built-in `role_admin` / **Platform Admin** uses the backend's ERPBridge environment credential when `ERPBRIDGE_ADMIN_ENV_ACCESS=true`.
- Other roles must save their own ERPBridge tokens through Profile -> My ERP connections. They never fall back to the administrator's credential.
- Server-managed credentials cannot be read, replaced or removed through the profile API/UI. Personal tokens remain encrypted in server storage.
- Tool/role authorization, exact reviewed contracts, policy decisions, independent approvals and idempotency remain separate mandatory controls. Environment access is not an all-tools grant or permission to bypass ERP authorization.
- Queued requests retain an actor-bound private credential receipt. A server token/endpoint/role-map change, account suspension, role change or disabling the mode blocks old work rather than silently rebinding it.

## Environment/secret configuration

The existing hosted bridge origin and bearer credential are retained in server-only Secret Manager `LCWE_RUNTIME_CONFIG`; they are not bundled into frontend `VITE_*` values. Only the following runtime option was added:

```dotenv
ERPBRIDGE_ADMIN_ENV_ACCESS=true
```

Existing JWT and storage-encryption keys, Firestore workspace, model provider and deferred pipeline configuration are preserved. No local emulator records or users are migrated to cloud storage.

## Supplied tool guide

All **140** names in the user's supplied ERPNext guide were found among the hosted bridge's **152** discovered tools. This verifies advertised presence, not successful execution or authorization for all tools.

The hosted bridge defaults to serving aliases rather than advertising `.rev_` names. Current low-code source supports **132 version-and-digest-pinned read aliases**, subject to explicit review. No bridge source/configuration change or removal of digest pinning was needed for those reads. Unqualified write aliases do not receive that read-only compatibility path.

Repository-owned guidance was added in `backend-ts/src/prompts/erpnext-tool-usage.ts`. It covers exact record identities, bounded paging/counts, schema-correct JSON strings versus native arrays, sequential tool use, write/assignment controls, supported business domains and integration-account identity. It does not copy untrusted document commands into privileged instructions or hardcode one company/year for every ERP.

Important correction to the supplied generalization: ordinary record getters such as `get_item` take `name`, but `get_current_user` takes no arguments, `get_user_details` requires `users`, and `get_value` requires `doctype`, `fieldname` and `filters`. Live schemas take precedence.

New prompt versions preserve historical prompt bytes:

- Query: `prompt/query/v6`.
- Action assistant: `prompt/action/v5`.
- Workflow generation: `prompt/candidate/v21`.

Historical runtime/model contracts and saved workflow logic were not retroactively rewritten. The guide does not grant all 140 tools to every role.

## Verification before release

- Full backend suite after the administrator-mode change: **5,233 passed, 0 failed, 1 skipped**, 210 files.
- Full frontend suite after the restored profile UI: **1,247 passed, 0 failed**, 141 suites.
- Subsequent prompt/provider/authorization/queue/synthesis regressions: **871 passed, 0 failed**, 12 files.
- TypeScript checking, actual seven-export Functions build and strict artifact verification passed.
- Project-bound Hosting build/verification and 20 Hosting configuration tests passed.
- All 86 public artifact files passed the known-private-value and credential-pattern scan.
- Live local profile testing confirmed hidden administrator environment state and discovery-only connection testing, with pending controls disabled.

An initial frontend bundle was correctly rejected after the profile source changed. The user explicitly approved restoring the admin-environment section; the suite and artifact were rebuilt afterward. Earlier failed intermediate runs are superseded by the passing results above, not deleted.

## Deployment status

Both deployments completed successfully using the requested account `lakshan.b.sanjeewa@gmail.com` and Firebase CLI 15.33.0.

- Frontend: https://workflow-automation-44201.web.app/ . Its HTTP 200 index matches the tested Hosting artifact exactly.
- Hosting version: `sites/workflow-automation-44201/versions/b0fffdb50725ebee` (86 public files).
- Backend health: https://asia-south1-workflow-automation-44201.cloudfunctions.net/api/healthz (HTTP 200).
- Application API: `https://asia-south1-workflow-automation-44201.cloudfunctions.net/api/api`.
- All seven backend functions are ACTIVE and use `LCWE_RUNTIME_CONFIG` version **2**. The runtime configuration matches the preserved local deployment configuration with only the new opt-in field added.
- Only the API edge is public. All six non-API functions remain private. The established runtime identity's narrowly scoped worker invocation/queue permissions were restored/read back after deployment; no Owner/Editor role or anonymous worker access was granted.
- Live API and browser testing both confirmed **Administrator environment credential · value hidden**, the hosted `/mcp/` endpoint, disabled controls during discovery and a successful connection-test acknowledgement.
- An attempted profile-API replacement of the server credential was rejected with HTTP 403 `ERP_ADMIN_ENVIRONMENT_MANAGED`.
- Eight existing workflows and the two previously reviewed Platform Admin tools were preserved. No new business-tool role grants, ERP writes, emails or schedules were added.

Follow-up verification confirmed the original model operation `chatop_214_1896fb5f` in `chat_213_009de48d` completed as `ANSWERED`; the HTTP 429 was encountered by the observer and was not evidence of a failed provider call. Company/Department read contracts had drifted from their saved reviews. With the user's explicit approval, only those two existing Platform Admin reads were refreshed, and the canonical version 3 supervisor draft passed readiness and was published. The subsequent attempted retrieval-run verification did not confirm a successful ERP result; its timeout/failure is retained as a limitation, not described as a successful demo. No broader business grants or writes were added.

A later performance/native-storage release on the same date supersedes the version 2 deployment above: all seven functions are ACTIVE on runtime secret version **3**, with native workspace `lcwe-staging-native-20261016`. The version 2/source evidence above is retained as history. See [Performance and native database release](PERFORMANCE_AND_NATIVE_DATABASE_2026-10-16.md) for the completed migration, actual index/capacity readback, before/after timings and browser/API acceptance. The administrator environment credential mode and hidden-token boundary were reverified after that migration.

Evidence: `ops/deployment/firebase/admin-environment-release-20261016.local.json`, `hosted-release-after-20261016.local.json`, `admin-env-deployed-verification-20261016.local.json`, `admin-env-demo-diagnosis-20261016.local.json`; screenshot `reports/admin-env-hosted-ui-20261016.png`. Local JSON evidence is ignored and must not be published with credentials/private application state.

## Demo scope

After live verification, use the existing reviewed Company/Department sample and ordinary conversation. Suggested prompts:

1. `Explain what a draft workflow is in one short sentence. Do not call ERP tools or change anything.`
2. `Show the first five company names from the ERP. Use the available reviewed tool and do not change records.`
3. `Now show the first five department names. Label this as a page of results, not the total department count.`
4. `Explain the saved Supervisor - Company and Department Reference Review workflow. Do not run or edit it.`

The existing 13-node supervisor template contains 2 ERP reads, 6 decisions and 5 terminal returns, not 13 ERP calls. Its manual Yes/No scope inputs are not independent human approvals. ERP writes, email delivery and scheduled business operations are not implied by this demo.

ERPBridge, RAG and pipeline deployments remain separate. The hosted pipeline is intentionally unconfigured; the earlier local RAG/provider and missing-pipeline-fixture limitations remain outside this staging frontend/backend release.
