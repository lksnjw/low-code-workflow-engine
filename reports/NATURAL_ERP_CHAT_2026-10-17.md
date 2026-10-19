# Natural ERP chat and required-field validation

Date: 17 October 2026. Target: the existing staging preview, not a production qualification.

## Expected behavior

| Request | System behavior |
| --- | --- |
| Greeting, explanation or brainstorming | Natural conversational response; no ERP call or new workflow |
| Retrieve records, count, compare or analyze | Agent discovers the needed current tool, checks its schema and retrieves bounded data |
| Create or edit an ERP record | Exact in-chat proposal, followed by explicit confirmation; not automatic workflow creation |
| Generate a workflow or recurring automation | Separate workflow-authoring path; editable draft, not automatic publication/execution |
| Ask a normal follow-up while a workflow is selected | Conversation continues; the saved draft is not automatically replaced or changed |
| Required values missing | Ask for those values; no invented identifiers, defaults or dispatch |

Example prompts:

- `Show the first five stock-balance records and explain what they mean. Do not change anything.`
- `Create an Item with item_code QA-ITEM-003, item_name QA Item, item_group Finished Goods, stock_uom Nos and is_stock_item 1. Prepare it for confirmation here in chat, not a workflow.`
- `Update only the description of Item QA-ITEM-003 to the exact text "Reviewed inventory item".`
- `Generate a manual workflow to retrieve inventory records, analyze them and request approval before a change. Do not run it.`

## Changes

Pi remains the orchestration engine. The backend owns actor checks, input/output validation, policy, exact confirmation, durable dispatch evidence and recovery.

- Added a versioned semantic-routing contract distinguishing ordinary discussion, retrieval/analysis, direct operations and explicit workflow generation.
- Removed the automatic conversion of ERP change requests into workflow generation.
- Removed hidden workflow drafts from ordinary query/action replies.
- A clarification labelled with an underlying ERP intention is safely converted to a tool-less conversational question rather than rejected.
- Added three small agent tools: catalog search, exact schema inspection and invocation/proposal. The agent does not receive all 152 complete schemas on every turn.
- Required properties, declared types, enums, unsupported fields, blank required inputs, placeholders and declared JSON-string contents are checked before dispatch. Arrays are not silently changed into strings or vice versa.
- The schema is checked again against the current bridge contract before SDK entry. Responses are validated and credential fields removed before presentation/model use.
- An exact, structured ERPBridge `not_found` marker for a read-only `get_*` lookup can establish absence during a duplicate check. A plain error message, permission failure or timeout cannot do so.
- Added in-chat review/confirmation cards, busy states, status retrieval and saved ERP responses. Duplicate confirmations do not repeat a write. Unknown outcomes have no blind Retry.
- Supported read-result charts remain separate from mutation receipts. Model prose cannot acknowledge a new effect that the request did not execute.

## Administrator boundary

`ERPBRIDGE_ADMIN_CHAT_ACTIONS=true` explicitly enables this direct live-catalog chat profile for the active built-in Platform Admin only. It uses the configured administrator credential or its captured personal binding. The ERPBridge token still limits what the upstream ERP permits. No additional local per-tool grant is required for this administrator profile.

This is not a grant to every role. Other roles retain existing reviewed-tool access and their own ERP credentials. Existing workflow publication/runtime approval controls are unchanged. Administrator confirmation of an exact direct chat transaction is separate from those workflow controls.

Business arguments, requests and results remain normal native database content. Actual credentials remain protected; passwords remain hashed. The journal's integrity hash is not whole-business-content encryption.

## Verification

- Backend: **5,370 passed, 0 failed, 1 skipped**, 266 suites.
- Frontend: **1,261 passed, 0 failed**, 143 suites; final affected confirmation/message tests additionally passed 32/32.
- TypeScript checking, Functions artifact verification, Hosting artifact verification and public credential scan passed.
- Local app + real Qwen + hosted ERPBridge: company lookup, missing-field clarification, stock Item creation, fresh readback, browser-confirmed description update and fresh update readback.
- The same browser chat created an ERP Customer business record, then retrieved it. No platform login account was created.
- Normal conversation and ERP actions produced zero implicit workflows. An explicit request then saved exactly one validated three-step draft, `wf_177_015d777b`. It was not published or executed. A normal follow-up left draft revision 1 unchanged.
- Synthetic records: Item `LCWE-QA-20261017-CHAT02`; Customer `LCWE QA Natural Customer 20261017`. No stock quantity was posted and no email was sent.

The original local automation report stopped because its assertion included a final sentence period as part of the requested description, while the model excluded that punctuation. That report was preserved. The exact displayed value was subsequently confirmed through the browser and verified by a fresh ERP read; follow-up evidence records the distinction.

## Deployment and evidence

Frontend: https://workflow-automation-44201.web.app/

All seven backend functions were updated to source hash `4fbf62c01a71814496a78309ba5d073a4023708d`. Private-worker invocation/enqueue grants for the existing runtime identity were restored and verified without making task workers public. The four queues and two schedulers were restored to their exact prior running/enabled states.

Evidence:

- `tmp/local-performance-20261016/natural-chat-backend-settled-20261017.json`
- `tmp/local-performance-20261016/natural-chat-frontend-full-20261017.json`
- `ops/deployment/local/natural-chat-ui-followup-20261017.local.json`
- `ops/deployment/local/natural-chat-final-20261017.local.json`
- `ops/deployment/local/natural-chat-real-item-readback-20261017.png`
- `ops/deployment/firebase/natural-chat-worker-release-after-20261017.local.json`
- `ops/deployment/firebase/natural-chat-staging-acceptance-20261017.local.json`

## Remaining boundaries

- This pass does not establish a complete live image/PDF upload, OCR, pipeline and RAG round trip. Those separately hosted services must be connected and their current reviewed document version confirmed. Merely attaching a file is not permission to invent extracted data or generate a workflow.
- A workflow for image extraction and ERP creation can only be runnable when its required registered tools, data mappings and approvals are available. Otherwise unresolved requirements must remain visible.
- The legacy curated local workflow write-review pack imported nine capabilities but stopped on its later review step. Direct administrator chat create/edit tests use the new exact-confirmation boundary; do not mistake them for acceptance of every legacy workflow write profile.
- Discovery of 152 tools does not mean all 152 were executed. Destructive actions, payroll/payment actions, real personal records and unsolicited messaging were not exercised.
- Provider inference and multi-turn schema/reference checks are not instantaneous. Loading/progress is shown; no instant-response claim is made.
- ERPBridge, RAG and pipeline source/deployments were not changed by this feature.

## Final hosted acceptance

The staging acceptance report finished **PASSED**. In saved chat `chat_280_de407b91`, real Qwen responses completed natural conversation, a two-record Company lookup, missing-field clarification, an exact confirmed Item update and a fresh `get_item` readback. The returned ERP description was `Natural chat local and staging verified`. Exactly one synthetic ERP update was dispatched by the staging acceptance script; no workflow artifacts were generated by those five requests.

The deployed browser UI also showed the real readback and fetched the current status of the older proposal. It displayed the completed ERP response, not an executable confirmation control. Screenshot: `ops/deployment/firebase/natural-chat-staging-readback-20261017.png`.

Observed end-to-end staging request times were approximately 17–64 seconds, including queue/cold-start/provider and multi-turn tool work. This verifies function, not an instant-response performance target.
