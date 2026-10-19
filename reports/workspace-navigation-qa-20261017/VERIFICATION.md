# Workspace and overnight human-review verification

Verified locally on 17 October 2026. This is source, automated-test and local-browser evidence, not a hosted deployment report.

## Delivered behavior

- Agent Workspace shows a metadata-only Saved workflows list, newest first, 20 records per page. Selecting a saved workflow opens its canvas; another owner's private chat is not opened.
- Open in canvas stays in the conversation. Selecting another workflow keeps the unsent composer text.
- Selecting Split view enters Focus with both chat and canvas visible. Focus no longer changes Split to Chat only. Exit restores app navigation; divider resizing and the mounted drafts are retained.
- A zero-step saved workflow explains its missing requirements instead of showing a blank grid. Saved, validated, published and executed remain different states.
- Runtime human approval is visible in both panes, including an explicit Human approval gate before an action that the authoritative authoring guidance marks as requiring approval. Its connector is labelled If approved.
- Selecting a waiting approval gate opens the existing exact-transaction reviewer inside the workspace, without selecting an editable ERP node. Future gates explain the requirement without inventing a pending transaction.
- Chat only and Canvas only/floating chat can use the same review dialog. It loads current exact business arguments lazily and keeps the existing explicit confirmation, authorization, review hash, expiry and no-blind-retry controls.
- A later checkpoint in the same run cannot retain the earlier checkpoint's displayed approval or its open review.
- Build-proposal review text no longer falsely promises automatic execution or removal of future runtime approvals.
- Dashboard has a Needs human approval queue for the current assigned reviewer role. It includes workflow, exact waiting step, tool, requester, request time, expiry and scheduled occurrence time when present. The small queue links to the paginated Review inbox.
- Approval-only reviewers can open Dashboard without receiving the personal run list, workflow catalogue or chat access.
- The dashboard shares the notification bell's bounded metadata query, but confirms current state on mount even with a warm cache. Unavailable storage is not shown as an empty queue.
- Review requests are not filtered to today's run date. Earlier requests remain discoverable until their lifecycle closes; decision history remains separate from pending work.

## Overnight workflow semantics

1. The scheduler admits a run using its published workflow snapshot.
2. The worker saves completed steps, then saves the exact approval record and pauses before its governed action.
3. An assigned manager signs in later and finds the request in Dashboard or Review inbox. An open browser/chat is not the durable record.
4. The manager inspects the exact payload and explicitly approves or rejects.
5. For supported managed operation runs, approval queues the continuation for fresh authority checks. Completed earlier reads are not repeated. Approval itself is not ERP success or delivery evidence.
6. Rejection records a decision without dispatching the waiting action.

Approval validity must cover the expected delay. The current policy supports 60–86,400 seconds (up to 24 hours). Configure an overnight validity before starting the run; changing the policy can invalidate existing reviews. Expired requests cannot be approved or silently extended. Their evidence remains inspectable, and a new authorized run/review may be necessary.

## Automated results

| Check | Result |
| --- | --- |
| Scoped frontend regression run | 21 suites, 371 tests passed |
| Runtime approval and scheduled ten-node tests | 2 files, 45 tests passed |
| Targeted existing operation review-inbox regressions | 15 tests passed; 435 unrelated cases intentionally skipped |
| Backend TypeScript check | Passed |
| Frontend production build | Passed |
| Scoped whitespace/error check (`git diff --check`) | Passed; existing unrelated line-ending warning noted |

The frontend regression scope covers the workspace layout, canvas/editor/graph, chat message/window/page, workflow lists/sidebar pagination, account isolation, exact review, approval policy, dashboard and inbox service contracts.

The scheduled tests include daily, weekly and monthly ten-node workflows: nine synthetic reviewed reads, a human checkpoint, and one synthetic effect after approval. The new overnight case restores the canonical Firestore record layout, advances the clock by eight hours under a preconfigured 24-hour policy, finds an actionable request, approves it, then completes with ten total tool calls, not nineteen. This is a simulated delay and record-layout restoration, not an eight-hour live cloud test.

## Live browser scenarios

Tested the real local frontend and HTTP handlers with opt-in memory-only fixtures, no external ERP/provider network:

- Saved workflow pagination: first 20 and next page; return to newer records.
- Zero-step saved draft, unresolved requirements, and same-chat Open in canvas.
- Add a local draft step, Apply, sidebar refresh, and reload persistence within the fixture process.
- Focused Split, keyboard divider, Exit/restore, and preservation of unsent text.
- Human approval node, chat/canvas notices, exact review dialog, and no automatic node-editing context.
- Explicit synthetic approval recorded as APPROVED, not as ERP execution.
- Review from Chat only and Canvas only/floating chat.
- Dashboard pending task -> exact review -> confirmed rejection -> empty pending queue on return.
- Separate approval-only reviewer login -> Dashboard pending queue, without chat, workflow-list or personal-run access.

Screenshots in this directory:

- `empty-saved-draft.jpg`
- `focused-split-workspace.jpg`
- `human-approval-canvas.jpg`
- `inline-human-approval.jpg`
- `approval-recorded-not-executed.jpg`
- `manager-dashboard-approval-queue.jpg`
- `manager-reviewer-dashboard.jpg`
- `rejected-review.jpg`

The browser approval fixture intentionally has no operation dispatcher. Its approved run remains blocked and explicitly says no ERP action was sent. Real continuation semantics are verified separately by the synthetic normal-worker scheduled tests.

## Deployment and data boundaries

- Hosted frontend/backend, ERPBridge, RAG and pipeline were not deployed or modified remotely in this work.
- The local browser fixture is memory-only and does not survive its backend process restart. The overnight persistence checks use the canonical record-layout and repository regression tests; they do not prove the current hosted database configuration.
- Production overnight operation additionally requires durable backend storage, configured task/schedule delivery, an active service principal, assigned reviewer roles and a sufficient approval lifetime.
- No real ERP transaction, email, real business document or live model call was used for this UI verification.
- No permission or approval-policy bypass was introduced. The backend remains authoritative for who may decide and whether a managed action may continue.
- Existing dirty/untracked repository work was preserved. Nothing was staged, committed or pushed.

## Main implementation locations

Frontend:

- `src/components/navigation/SidebarSavedWorkflows.jsx`
- `src/components/chat/ChatWorkspaceLayout.jsx`
- `src/components/chat/WorkflowRunApproval.jsx`
- `src/components/chat/WorkflowWorkspaceEditor.jsx`
- `src/components/chat/WorkflowMiniCanvas.jsx`
- `src/components/chat/miniWorkflowGraph.js`
- `src/components/dashboard/DashboardApprovalQueue.jsx`
- `src/pages/dashboard/DashboardPage.jsx`
- `src/services/execution-review.service.js`
- `src/components/workflows/PendingGenerationApprovalCard.jsx`

Backend:

- `src/runner/execution-review-inbox.ts`: adds safe scheduled-occurrence time to existing minimum review metadata.
- `tests/local-ten-node-schedules.test.ts`: scheduled pause, record-layout restoration, overnight discovery and approval/continuation evidence.
- `scripts/workspace-qa-server.mjs`: opt-in, isolated local UI fixtures only.
