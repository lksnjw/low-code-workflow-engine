# ERP readiness and local response-speed audit

Date: 16 October 2026 (Asia/Colombo).

## Outcome and scope

The administrator's blocked-read scenario was reproduced and resolved in an isolated local workspace using the **hosted ERPBridge**, actual ERP Company/Department reads and the configured **DeepSeek model through OpenRouter**. This was not a local substitute for the hosted bridge.

The local frontend is http://127.0.0.1:5196/ and the local backend is http://127.0.0.1:8081/ . Storage uses the loopback Firestore emulator and a separate `hosted-bridge-local-native` workspace. The previous demo workspace/export is retained. The frontend serves a production-shaped, split bundle rather than a development watcher.

No cloud release, ERPBridge source/configuration, RAG source, pipeline source, business write, email delivery or active business schedule was changed by this audit. Only Company and Department reads were reviewed for Platform Admin in the isolated local workspace. Do not describe the complete product as fully ERP-ready: the remaining compatibility and business-acceptance work below is real.

## Why an administrator saw “No ERP read tools”

The application's effective tool set is the intersection of:

1. A configured, connected ERPBridge session and the actor's own authorized credential, or the explicitly enabled administrator environment credential.
2. A discovered exact remote schema/version/digest that the platform understands.
3. A current local capability review, not disabled or superseded by contract drift.
4. A tool role grant matching the current user's effective role.
5. Mandatory dispatch validation, policy, purpose and data-egress checks.

Administrator login does not replace those reviews. The exact screenshot message is a server-created `NO_APPROVED_READ_TOOLS` response, not evidence that DeepSeek failed. Previously its copy told an administrator to ask another administrator, without providing a recovery action.

The blocked request was reproduced before local review. After reviewing the two exact read contracts, the same kind of request returned **three company names** and **five department names** in real UI tables. No saved workflow was created by those lookups; the query's transient read-plan artifact is not a published workflow or an execution permission.

A separate current read-only inspection of the deployed configuration found the administrator environment credential configured, ERPBridge **CONNECTED**, and Company/Department capabilities **AVAILABLE**. Their discovery observations were older than the review-window freshness limit; `OBSERVATION_STALE` means a fresh discovery is needed before another review, not that an already matching AVAILABLE admission has automatically expired. A saved old blocked message must remain as historical evidence; changing today's configuration does not rewrite that answer.

Codex can invoke its configured MCP tools directly. The low-code backend applies the additional review/role/contract/approval boundary above. Matching connectivity therefore does not imply identical permission behavior. MCP annotations are advisory hints, not authorization: [MCP schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-03-26/schema.ts).

## Implemented in this local pass

- Administrator-specific missing-read guidance explains the review boundary and provides **Review ERP tool access**, opening the actual `/registry/tools` page. Live browser testing caught and corrected an initial incorrect `/registry` link; tests alone had not exposed that routing error.
- The recovery button is based on current Platform Admin/registry-write permission, not a historical assistant artifact. Other roles retain appropriate administrator/own-credential guidance. No automatic grant or silent re-review was added.
- The local hosted-bridge profile explicitly enables administrator environment credentials. Tokens stay backend-only. Other-role fallback to this credential was not enabled.
- A separate native-format local workspace avoids silently treating old encrypted manifests as native indexed records. Legacy/native layout mismatch now fails with an explicit migration error rather than a canonical-JSON TypeError.
- Database packet comparisons compare binary payload bytes directly. They no longer serialize large binary buffers as hundreds of thousands of JSON numeric properties. Exact native data/index comparisons and tamper checks remain enforced. Previously three large-record tests hit their 5-second limit; after this fix the targeted storage/API suite passed all 200 assertions without relaxing test timeouts.
- Chat progress immediately reopens one held read after genuine new progress, removing the previous fixed 1.5-second delay after each stage update. Unchanged replies retain the bounded interval; cancellation and reconnection remain read-only and never resubmit a command.
- An explicit `openrouter-deepseek-interactive-fast/v1` sampling profile disables optional reasoning for the exact configured DeepSeek/OpenRouter model and five current interactive routing/conversation/query/action prompt contracts. It does not alter generation, historical prompt versions, other providers/models or reviewed runtime nodes. The actual profile is saved in invocation provenance; normal validation, tool authority and egress checks remain enforced. This is a narrowly scoped inference change, not a general guarantee of lower latency. See the [official OpenRouter reasoning parameter documentation](https://github.com/OpenRouterTeam/docs/blob/main/guides/best-practices/reasoning-tokens.mdx).
- A production-shaped local frontend profile uses existing route splitting and same-origin backend APIs, with no owner `.env` leakage or HMR watcher. An earlier separate development-server sample consumed about 3 CPU-seconds over a 2-second observation; that observation is not a formal root-cause proof for all latency.
- Reproducible, bounded local latency and compatibility probes were added. Previously approved interactive-only DeepSeek configuration is reused without exporting its key or enabling runtime-analysis/runtime-agent egress.

## Measured local results

Five local HTTP observations per read endpoint against the resident backend and emulator:

| Request | Median | Range |
| --- | ---: | ---: |
| Current user | 2 ms | 2–5 ms |
| Configured model catalogue | 3 ms | 2–9 ms |
| Chat list, limit 20 | 3 ms | 2–4 ms |
| Workflow list, limit 20 | 3 ms | 2–4 ms |

Repeat measurements using the same model and real hosted ERPBridge. These are single observations per case/profile, not a controlled statistical benchmark:

| Scenario | Default profile complete | Fast profile acknowledgement | Fast profile complete | Evidence |
| --- | ---: | ---: | ---: | --- |
| Company lookup after review | 16,819 ms | 119 ms | 17,254 ms | One successful hosted ERP read; 3 company names |
| Department follow-up in the same chat | 22,600 ms | 144 ms | 9,054 ms | One successful hosted ERP read; 5 names, partial-page label |
| Ordinary conversation | 18,868 ms | 139 ms | 3,367 ms | Real model answer; no ERP call |

Before local tool review, the blocked Company request was acknowledged in 142 ms and completed in 4,878 ms with zero ERP calls. That guard remains enforced.

The fast profile improved the Department and ordinary-conversation observations, but **did not improve the Company observation**. Remote model variation is significant: default-profile ordinary conversation spent about 6.8 seconds routing and 11.1 seconds generating its answer; the fast-profile equivalents took about 1.3 and 1.1 seconds. The fast Company case still spent approximately 13.9 seconds in three sequential model calls. This is evidence that optional reasoning and model round trips matter, not proof that every request is now fast. All eight invocations in the latest run recorded the intended fast profile and succeeded.

Earlier preliminary measurements were faster (Company 8.5 seconds, Department 6.4 seconds, conversation 3.9 seconds), but are retained separately rather than substituted for the later runs. An initial diagnostic probe also repeatedly polled cursor zero; it was corrected to advance the saved cursor before these repeat measurements. No uncertain operation was resubmitted.

The browser showed disabled duplicate-send controls and loading feedback immediately. The complete response timings include intent routing, tool planning, remote work, model presentation, polling and persistence; they are not pure DeepSeek inference measurements or browser p95 measurements. Separate Codex Company/Department MCP observations were about 0.39/0.36 seconds; those omit the low-code model/governance/persistence path and are not an apples-to-apples model benchmark.

“Instant” should mean immediate acknowledgement and honest progress, not a fabricated instant ERP/model answer. Real token streaming is not implemented by this pass: the provider adapter currently waits for bounded JSON completions. Streaming can improve first-visible-text latency, but cannot turn an unconfirmed write into success. [OpenRouter latency/performance guidance](https://github.com/OpenRouterTeam/docs/blob/main/guides/best-practices/latency-and-performance.mdx).

## Current compatibility inventory

Actual hosted discovery advertised **152 tools**: **63 array-root** and **89 object-root** output contracts. **132** have contracts supported for explicit local review; this does not mean all are approved, executable by every role or exercised in this audit.

**20 contracts remain unsupported for import in the current advertised shape:**

- **18 effect tools:** `cancel_document`, `complete_assignment`, `create_assignment`, `create_customer`, `create_item`, `create_item_price`, `create_supplier`, `delete_customer`, `delete_document`, `delete_item`, `delete_item_price`, `delete_supplier`, `insert_document`, `remove_assignment`, `reopen_assignment`, `submit_document`, `update_document`, `update_item`.
- **2 read tools:** `get_user_details`, `get_value`.

The 18 effect tools are advertised as unqualified serving aliases. The current adapter's alias compatibility path intentionally admits only explicitly reviewed reads. These write tools also need exact result/confirmation contracts before the platform can safely enable them; an unrestricted object output alone does not define transaction success. Do not remove digest/version pinning or misclassify writes as reads to make the count look complete.

`get_user_details` uses schema-valued `additionalProperties` and unconstrained JSON fields. `get_value` declares an object/array type union. The current bounded tool-schema profile rejects these forms. Supporting them needs complete bounded validation in import, argument/output checking and UI inspection, plus regression tests. Dropping constraints to coerce them into the current profile would be an unsafe workaround.

No specifically advertised leave, attendance or email-sending tool was present. Existing generic search/count tools are not proof that the bridge credential can query a missing HR domain. A request for sick-leave counts needs a confirmed authorized Leave Application/HR capability and exact period/status filters, not a guess from employee-list length.

## Prioritized ERP-readiness work list

| Priority | Work item | Current state / required acceptance |
| --- | --- | --- |
| P0 | Administrator connection and access recovery | Fixed locally for the confirmed missing-read case. Browser review link tested. Release only after review of the local changes. Extend diagnostics to distinguish credential rejection, disconnected session, role denial, drift and unsupported schemas explicitly. |
| P0 | Role-specific business capability packs | Build reviewed Finance, HR, Purchasing and Operations packs from real exact contracts; show what is enabled and why another tool is unavailable. Test each actual role/token combination. Never use the admin token as an unannounced fallback. |
| P0 | Hosted effect-tool contracts | Coordinate versioned discoverable names, or separately qualify digest-pinned write-alias semantics and exact success/readback contracts. Requires bridge-owner coordination; it is not a prompt-only low-code fix. Keep current writes unavailable until proven. |
| P0 | End-to-end write lifecycle | Start with one explicitly selected non-financial business operation, such as creating a synthetic customer in an isolated ERP. Verify proposal → reviewed field diff → independent approval → exact one-time dispatch → ERP receipt/readback → audit. Unknown outcomes require reconciliation, never blind retry. No write was performed here. |
| P0 | Accurate daily-report evidence | Exact company/entity, timezone, date window, filters, currency and count semantics. Test empty, partial, multi-page and denied results. Display receipt-backed tables/charts; do not report a bounded page as a complete total. |
| P1 | Two remaining read-schema forms | Implement bounded dictionary/unconstrained-JSON/type-union validation without weakening existing contracts; test invalid results, depth/item limits, reserved keys and secret removal. |
| P1 | Model/tool latency breakdown | Invocation provenance now separates model latency/tokens from end-to-end chat and local HTTP observations. Record queue, provider first byte, discovery, ERP read, persistence and UI presentation separately. Add production p50/p95/error-rate evidence and qualify the fast inference profile with a larger comparable sample. |
| P1 | Real model streaming | Add cancellable, bounded partial-text transport and UI while retaining a final authenticated saved result. Partial text must be visibly provisional; no action dispatch from partial tool arguments. |
| P1 | Dynamic payload repair | Existing schema-based proposal correction handles selected validation errors. Expand exact-array versus JSON-string and enum/required-field cases with tests. Correction may repair an unsent proposal, not automatically repeat a possibly executed write. |
| P1 | Daily schedule acceptance | Existing daily/weekly/monthly scheduler requires an immutable published workflow and report-window bindings. Qualify actual task delivery, timezone boundaries, missed occurrences, suspension, duplicate prevention and approval behavior for each business template. Merely generating schedule text is insufficient. |
| P1 | Email/notification channel | In-app notifications exist; no hosted email tool was observed. Add an authorized delivery integration with recipient resolution, preview, explicit approval and delivery evidence only when requested/configured. Do not label a draft as sent. |
| P1 | Document/RAG/pipeline qualification | Keep retrieval behind ERPBridge and uploads behind the trusted backend gateway. Qualify actual deployed pipeline/RAG endpoints, tenant/owner restrictions, schema-collection routing, summary updates, upload errors and permission revocation. This turn did not start or qualify those independent services. |
| P1 | Spreadsheet/batch record creation | Reviewed schema mapping, exact ERP identifiers, per-row validation/duplicates, bounded batches, row receipts, rejected rows and safe resume. File upload alone is not authority to create hundreds of ERP records. |
| P1 | Saved workflow/chat usability | Retest follow-up discussions, two workflows in one chat, draft edits, publish-version mismatch, reload, delete/restore expectations and user switching with real roles. Existing saved-chat privacy and 20-item paging must remain intact. |
| P2 | Scoped database reads at scale | Indexed paging and warm verified reads already exist. Cold/changed-head reads still hydrate the coherent workspace; implement permission-safe targeted projections before claiming all database work is O(page size). Benchmark with realistic thousands of chats/runs. |
| P2 | Hosting/runtime latency controls | Compare a resident/container backend with current serverless cold starts. Region placement, minimum instances and larger resources affect cost and need an explicit deployment decision; nothing was redeployed here. |
| P2 | Operational readiness | Least-privilege IAM, secret rotation, rate-limit handling, redacted tracing, backup/restore rehearsal, cost alerts, incident runbooks and real role acceptance remain production gates. Passing tests is not full operational qualification. |

## Daily-work scenarios and honest status

| User request | What the system should do | Current evidence |
| --- | --- | --- |
| Show five companies | Use reviewed list tool, return a bounded table | Verified locally through hosted ERPBridge |
| Now show departments | Follow conversational context, use a separate reviewed read | Verified in the same chat |
| Explain a draft workflow | Natural model conversation, no ERP call | Verified |
| How many people are on sick leave today? | Clarify timezone/date/status, use authorized HR/count capability | Not qualified; no specific leave tool observed |
| Prepare an email | Produce an editable draft; do not claim delivery | Existing draft path; hosted sending capability missing |
| Create a customer from this form | Extract/review fields, resolve duplicates, approve exact write, verify ERP record | Contract/integration work remains; no current write claim |
| Run this report every morning | Publish reviewed workflow; bind reporting window/timezone; explicitly activate schedule | Scheduler source exists; this hosted business scenario not qualified |
| Retry after a timeout | Inspect saved operation and side-effect evidence before offering safe retry | Existing guarded recovery; never an unconditional replay |

## Local use and verification

Open http://127.0.0.1:5196/chat/chat_44_779eeb85 to inspect the latest retained Company/Department/natural-conversation results. The earlier before/after-review evidence is retained in `chat_8_a50f5fa0`. Use a **new message** to request a new lookup; do not assume an old response automatically reruns. The first ephemeral QA chat (`chat_15_ab23ccef`) was lost when its foreground emulator stopped; its report/screenshots remain evidence, but that old URL is not the live handoff.

Useful prompts:

1. `Show the first five company names from the ERP using the reviewed company read tool. Return a small table. Do not change records or create a workflow.`
2. `Now show the first five department names. Label the result as a bounded page, not the full department count. Do not change anything.`
3. `Explain the difference between a draft workflow and a published workflow in two short sentences. Do not use ERP tools.`
4. `Before creating a customer, tell me which reviewed write capability and fields you would require. Do not create the record.`

Startup: `ops/deployment/local/start-hosted-performance.ps1` launches only the isolated local frontend/backend/emulator with installed dependencies and hidden helper windows. It refuses occupied ports instead of killing unrelated services. It prefers the final retained export at `tmp/local-performance-20261016/emulator-export-final`, falling back to earlier local exports, never a cloud database. This final export was captured after all three latest operations were terminal and the local snapshot had zero active chat operations; the new final export itself has not been restore-rehearsed. Earlier exports are retained. Emulator exports contain private local configuration/credentials and must not be published. JDK 21 is required; the machine's default older Java caused one startup attempt to stop and the installed JDK 21 resolved it.

Primary evidence, private/ignored unless deliberately sanitized:

- `ops/deployment/local/hosted-erp-performance-20261016.local.json`
- `ops/deployment/local/hosted-erp-performance-final-20261016.local.json` — repeat default-profile run
- `ops/deployment/local/hosted-erp-performance-fast-20261016.local.json` — latest live fast-profile run
- `ops/deployment/local/inference-default-20261016.local.json` and `inference-fast-20261016.local.json` — metadata-only provenance/timing breakdowns
- `ops/deployment/local/erp-readiness-20261016.local.json`
- `tmp/local-performance-20261016/backend-regressions-final.json` — 200 passed
- `tmp/local-performance-20261016/erp-authority-regressions-final.json` — 227 passed (overlapping checks, not additive)
- `tmp/local-performance-20261016/frontend-ui-release.json` — 70 passed
- `tmp/local-performance-20261016/backend-full-final.json` — 5,269 passed, 1 failed, 1 skipped, before the final fast-profile change. The one failure was the calendar approval/window recheck fixture hitting the observation-freshness guard during setup under the full run. It was not silently waived or fixed by weakening the guard.
- `tmp/local-performance-20261016/operation-jobs-isolated.json` — the entire affected operation-jobs file passed 450 tests in isolation. The exact failed case also passed separately. This does not turn the broad run into an all-green result.
- `tmp/local-performance-20261016/deepseek-fast-regression-release.json` — latest fast-profile/provider/chat/continuation/egress checks: 175 passed, 1 skipped, 0 failed. The complete backend suite was not repeated after this final provider change.
- `tmp/local-performance-20261016/frontend-full-final.json` — 1,255 passed, 142 suites

Backend TypeScript checking and the production backend bundle passed after the final provider change. The production-shaped frontend build passed. The public-artifact secret scan found none of the four configured private values in 192 scanned local output files; this is a known-value check, not a universal secret-detection guarantee. No cloud deployment was performed.

Screenshots: [administrator recovery](local-admin-tool-recovery-20261016.png), [actual review page](local-admin-review-page-20261016.png), [latest live Company table](local-hosted-erp-company-table-20261016.png).

The computer-use skill required actual visual/click verification. This found the recovery-link routing error that isolated component tests missed. Full ERP readiness remains a sequence of independently verified capability/business releases, not a blanket administrator bypass.
