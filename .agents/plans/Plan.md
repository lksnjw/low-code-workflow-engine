# Plan: Governed ERPBridge MCP Integration

## Goal

Connect the TypeScript workflow engine to ERPBridge's authenticated Streamable HTTP MCP endpoint so validated workflow steps can invoke real ERPBridge tools without weakening the engine's capability boundary. Use `@erpbridge/sdk` only as a private MCP transport adapter; never expose it to workflow code or use ERPBridge's admin-only REST invoke endpoint for execution. This implements [enhancement #1](https://github.com/lksnjw/low-code-workflow-engine/issues/1).

## Current State

- The TypeScript backend constructs `RegistryValidator`, then `createGovernedMCPClient`, then one `GenericMCPTool` per local registry definition before constructing `Executor` (`backend-ts/src/entrypoints/production.ts:37-47`).
- `Executor.run()` resolves step parameters, adds `_action`, issues a dispatch capability, then invokes the registered tool (`backend-ts/src/runner/executor.ts:92-105`). `RegistryValidator` binds the capability to the local action and canonical resolved-parameter hash (`backend-ts/src/validator/registry-validator.ts:179-202`).
- The current remote client verifies and consumes that capability before its closure-private HTTP call, then posts `{ action, parameters }` to `${MCP_BASE_URL}/tools/execute` (`backend-ts/src/tools/mcp-client.ts:26-48`). Capability tests prove rejected/mutated/reused calls make zero transport requests (`backend-ts/tests/capability.test.ts:48-150`).
- ERPBridge's supported remote MCP endpoint is `/mcp/`, with a JSON-RPC session lifecycle; `/api/tools/invoke` instead accepts `{ name, arguments }`, is admin-only with HTTP auth enabled, and cannot invoke MCP built-ins (`/home/nimendra/Documents/Projects/ERPBridge/docs/api.md:80-106,124-134`).
- ERPBridge issues opaque bearer tokens. A workflow-engine service account needs only `mcp` scope; registry, cache, direct invocation, and token management require the admin credential (`/home/nimendra/Documents/Projects/ERPBridge/docs/tokens.md:27-72`).
- For a guarded ERPBridge tool, MCP callers provide `arguments.role`; ERPBridge verifies that the role belongs to both the authenticated token and the tool allow-list, then removes it before the ERP call (`/home/nimendra/Documents/Projects/ERPBridge/internal/mcp/authz.go:45-125`).
- The SDK owns a Streamable HTTP MCP session, sends its configured bearer credential, and returns the full MCP result envelope (`/home/nimendra/Documents/Projects/erpbridge-sdk/src/mcp.ts:37-103,194-205`). Its released `@erpbridge/sdk@1.1.0` adds `mcpRetryPolicy: 'once' | 'never'`; the workflow engine must configure `'never'` because automatic replay is unsafe while its documented G3 idempotency invariant is not enforced (`backend-ts/docs/INVARIANTS.md`).
- Local engine registry entries provide the exact MCP name, input schema, local role allow-list, and read-only/risk metadata required by the validator (`backend-ts/src/registry/schemas.ts:4-34`). A blank local allow-list is permissive (`backend-ts/src/validator/registry-validator.ts:355`), so ERPBridge tools must not be automatically promoted into the executable registry with incomplete governance metadata.
- Baseline note: the current branch has a committed parity-fixture mismatch: `backend-ts/tests/crypto.test.ts` fails the frozen composite-registry hash assertion. Resolve this independently before treating the integration verification suite as green.

## Decisions

1. **Use authenticated MCP, not direct REST invocation.** The engine will call ERPBridge `/mcp/` through the SDK, because a scoped `mcp` token is sufficient. `client.invoke()` is excluded from workflow execution because it requires an admin credential. This follows ERPBridge's documented endpoint authorization model and also avoids creating a bespoke JSON-RPC/session implementation.

2. **Retain the workflow engine as the dispatch-policy authority.** The SDK is wrapped behind the existing `GovernedMCPClient`/`ExecutableTool` seam. The adapter receives a validator-issued capability and verifies it before a session lookup, SDK call, or any remote request. No handler, workflow, provider, or generic tool gets a usable SDK client.

3. **Disable SDK retry for workflow execution.** Add an SDK retry policy with the backwards-compatible default `once`, but configure the workflow engine to `never`. A timeout after a side effect is therefore an ambiguous failed dispatch, not permission to issue a duplicate call. Do not add workflow retry until G3 idempotency is implemented end-to-end.

4. **Bind trusted dispatch identity into the capability.** Add an immutable dispatch identity (`userId`, local role, mapped ERPBridge role) to the executor-to-tool call and to the capability's protected payload. The capability verification must reject an identity/role mismatch before transport. This prevents a capability minted for one role from being reused for another.

5. **Never accept a workflow-provided ERPBridge role.** For a locally role-guarded ERPBridge tool, reject a resolved `role` argument before transport; derive the role from the authenticated workflow user through an explicit, total configuration map. Inject the mapped role only after binding it to the capability. Open tools receive no synthetic `role` argument because ERPBridge reserves that field only for guarded tools.

6. **Keep the local registry curated and authoritative.** Use SDK `mcp.listTools()` only for a read-only compatibility check against the reviewed local registry. It must not auto-import or enable remote tools: ERPBridge discovery lacks the engine's mandatory risk, side-effect, process, and local-RBAC classifications. Registry changes remain an explicit reviewed import/update that invalidates existing validation tokens through the existing registry hash.

7. **Use a service account, while documenting its identity boundary.** ERPBridge will see the workflow engine's MCP service token as the caller and the mapped role as a delegated selector; the engine remains responsible for authenticating the human user and retaining user/execution audit records. This is defense in depth, not per-user token exchange. Do not represent it as end-user identity propagation.

## Scope

### In scope

- A private, SDK-backed, capability-governed ERPBridge MCP adapter in `backend-ts`.
- ERPBridge scoped-token setup, explicit local-to-ERPBridge role mapping, and role/parameter protection.
- A no-retry option in `@erpbridge/sdk`, consumed at a pinned released version.
- Read-only remote-tool compatibility verification and integration/operational documentation.
- Unit, contract, and opt-in live integration tests.

### Out of scope

- Calling ERPBridge's admin-only REST `/api/tools/invoke` from workflow execution.
- Automatically importing/enabling ERPBridge tools or policy rules.
- Sending the ERPBridge admin token to the workflow engine.
- Per-user OAuth/token exchange, multi-tenant credential delegation, or ERPBridge server authorization changes.
- Workflow retries, durable idempotency keys, or approval lifecycle work (G3/G4).
- Direct browser-to-ERPBridge calls.

## Tasks

- [x] **Task 0: Create isolated implementation branches and link the work.** In `low-code-workflow-engine`, first verify the worktree has no unrelated changes; fetch `origin`; then create `feat/governed-erpbridge-mcp` from `origin/feat/typescript-backend`. Keep this plan and all implementation commits on that branch. In `erpbridge-sdk`, create `feat/mcp-no-retry-policy` from its current upstream default branch for Task 2, because the SDK release must precede the engine dependency update. Do not reset, discard, or stash unrelated user changes. Open the SDK PR first; open the workflow-engine PR against `feat/typescript-backend` after the released SDK version is available, with `Refs #1` in its description. A later consolidation PR from `feat/typescript-backend` to `main` may use `Closes #1`; do not prematurely auto-close the issue from the feature-to-feature PR.
  **Seam:** Git branch ancestry and linked delivery flow.
  **Files:** `.agents/plans/Plan.md`; GitHub issue [#1](https://github.com/lksnjw/low-code-workflow-engine/issues/1); `/home/nimendra/Documents/Projects/erpbridge-sdk/.agents/plans/Plan.md` (if its active plan needs the retry-policy task recorded).
  **Verify:** `git -C low-code-workflow-engine status --short && git -C low-code-workflow-engine branch --show-current && git -C low-code-workflow-engine merge-base --is-ancestor origin/feat/typescript-backend HEAD`; repeat the branch/status checks for `erpbridge-sdk`.

- [x] **Task 1: Restore a green TypeScript-backend baseline and record the canonical fixture decision.** Determine whether the committed ERP registry fixtures or `fixtures/parity/crypto/vectors.json` is canonical; regenerate the other only from the chosen source, update its evidence hashes/context filename together, and add a regression assertion that the two raw fixture hashes and the composite hash agree. Do not begin integration assertions until `npm test` is green.
  **Seam:** `RegistryService.hash()` / frozen crypto-vector contract.
  **Files:** `backend-ts/fixtures/parity/crypto/vectors.json`; `backend-ts/fixtures/parity/http/runtime/all_tools_master_registry.json`; `backend-ts/fixtures/parity/http/runtime/all_rules_master_registry.json`; `backend-ts/fixtures/parity/http/runtime/registry_context*.md`; `backend-ts/tests/crypto.test.ts`; `backend-ts/docs/RESULTS.md`.
  **Verify:** `cd backend-ts && npm ci && npm test && npm run typecheck`.

- [x] **Task 2: Add an explicit no-retry MCP-call policy to the ERPBridge SDK and release it.** Extend `ErpbridgeConfigInput`/resolved config with a documented MCP transport retry policy (`once` default for compatibility, `never` for exactly-one call attempt). Make `McpClient.execute()` reconnect only under `once`; preserve the existing typed errors and cancellation behavior. Add hermetic MCP fixture-server tests proving the default reconnects once and `never` sends exactly one tool-call request after a transport failure. Update SDK README/changelog and the corresponding user-facing SDK docs. The change was merged and released as `@erpbridge/sdk@1.1.0` (`sdk-v1.1.0`).
  **Seam:** `McpClient.execute()` retry loop.
  **Files:** `/home/nimendra/Documents/Projects/erpbridge-sdk/src/config.ts`; `/home/nimendra/Documents/Projects/erpbridge-sdk/src/types.ts`; `/home/nimendra/Documents/Projects/erpbridge-sdk/src/mcp.ts`; `/home/nimendra/Documents/Projects/erpbridge-sdk/src/mcp.test.ts`; `/home/nimendra/Documents/Projects/erpbridge-sdk/README.md`; `/home/nimendra/Documents/Projects/erpbridge-sdk/CHANGELOG.md`; matching docs in `/home/nimendra/Documents/Projects/erpbridge-docs/docs/sdk/`.
  **Verify:** `cd /home/nimendra/Documents/Projects/erpbridge-sdk && npm test && npm run build && npm run lint:publish`.

- [x] **Task 3: Define configuration and an explicit role-map contract in the workflow engine.** Add `MCP_TRANSPORT=bridge-v1|erpbridge-mcp` (default `bridge-v1` to retain current behavior), `ERPBRIDGE_BASE_URL`, `ERPBRIDGE_MCP_TOKEN`/token-env selection, and a strict JSON local-role-to-ERPBridge-role map. In ERPBridge transport mode require a nonblank HTTPS endpoint outside development, a token, and a nonempty valid map; reject unrecognized role-map entries and duplicate target roles. Keep secrets out of diagnostics and public configuration responses.
  **Seam:** `loadConfig()` and `validateConfig()`.
  **Files:** `backend-ts/src/config/config.ts`; new `backend-ts/tests/config.test.ts` (or the existing relevant config test file); `backend-ts/README.md`.
  **Verify:** `cd backend-ts && npm run typecheck && npm test -- --run tests/*config*.test.ts`.

- [x] **Task 4: Preserve local capability guarantees while adding trusted dispatch identity.** Introduce a minimal immutable dispatch context passed from `Executor.run()` to `ExecutableTool.execute()`: authenticated user ID, local role, and mapped ERPBridge role. Extend the capability payload/mint/verify APIs so the exact local action, canonical business parameters, and dispatch identity are all bound and checked before consuming the capability. Remove the internal `_action` parameter from outbound business parameters; action is already a separately capability-bound field. Update both production workflow-run paths to pass identity from their authenticated `CurrentUser`, never from request/YAML input.
  **Seam:** `Executor.run()` → `ExecutableTool.execute()` → `RegistryValidator.verifyAndConsumeCapability()`.
  **Files:** `backend-ts/src/runner/executor.ts`; `backend-ts/src/tools/registry.ts`; `backend-ts/src/tools/generic-mcp-tool.ts`; `backend-ts/src/tools/mcp-client.ts`; `backend-ts/src/validator/registry-validator.ts`; `backend-ts/src/http/app.ts`; `backend-ts/src/http/handlers/uploads-executions.ts`; `backend-ts/tests/capability.test.ts`; `backend-ts/tests/http.test.ts`; `backend-ts/tests/chat.test.ts`; `backend-ts/docs/INVARIANTS.md`.
  **Verify:** `cd backend-ts && npm test -- --run tests/capability.test.ts tests/http.test.ts tests/chat.test.ts && npm run analyze:boundary`.

- [x] **Task 5: Implement the private ERPBridge SDK transport adapter.** Add `@erpbridge/sdk: 1.1.0` as a pinned production dependency and an adapter that implements the engine's governed-client interface while owning the SDK client privately. At boot it creates/connects an SDK MCP client configured with the scoped token and `mcpRetryPolicy: 'never'`; at shutdown it closes the session. For each capability-verified call it uses `mcp_tool_name` (falling back to the local action), rejects a caller-provided `role` for locally guarded tools, injects only the capability-bound mapped role for those tools, calls `client.mcp.callTool()`, throws on `isError`, and returns the complete MCP envelope without parsing text content. Preserve the existing `bridge-v1` and mock clients unchanged.
  **Seam:** `GovernedMCPClient` factory selected by the production composition root.
  **Files:** new `backend-ts/src/tools/erpbridge-mcp-client.ts`; `backend-ts/src/tools/mcp-client.ts`; `backend-ts/src/tools/generic-mcp-tool.ts`; `backend-ts/src/entrypoints/production.ts`; `backend-ts/package.json`; `backend-ts/package-lock.json`; `backend-ts/tests/erpbridge-mcp-client.test.ts`.
  **Verify:** `cd backend-ts && npm run typecheck && npm test -- --run tests/erpbridge-mcp-client.test.ts tests/capability.test.ts && npm run analyze:boundary`.

- [x] **Task 6: Prove the security and wire contracts at the adapter seam.** Use an injected SDK-client interface/fake rather than an exported transport to prove: all existing forged/expired/reused/mutated capability cases make zero SDK calls; a valid call occurs once; remote action naming is correct; an untrusted `role` is rejected; missing/mismatched role mapping is rejected; only the authenticated identity's mapped role is sent; MCP `isError` fails the workflow; and an ambiguous transport failure is not retried. Add a structural boundary check ensuring the raw SDK client is reachable only through the governed adapter.
  **Seam:** fake `callTool()` recorder behind `ErpbridgeMcpClient`; existing capability test harness.
  **Files:** `backend-ts/tests/erpbridge-mcp-client.test.ts`; `backend-ts/tests/capability.test.ts`; `backend-ts/scripts/analyze-boundary.mjs`; `backend-ts/docs/INVARIANTS.md`; `backend-ts/docs/RESULTS.md`.
  **Verify:** `cd backend-ts && npm test && npm run build:prod && npm run scan:prod && npm run analyze:boundary && npm run test:prod-inert`.

- [x] **Task 7: Add a read-only ERPBridge registry compatibility check, not an auto-sync.** Build a deployment/CI command that authenticates with the same scoped MCP credential, calls `mcp.listTools()`, and compares remote exact tool names/input schemas with the reviewed local entries whose transport is ERPBridge. Fail on missing, incompatible, or unreviewed tools; print a redact-safe drift report; never write the runtime registry. Add pure comparison tests with SDK-shaped tool fixtures.
  **Seam:** local `RegistryService.snapshot()` compared to SDK `McpClient.listTools()` output.
  **Files:** new `backend-ts/src/tools/erpbridge-registry-compatibility.ts`; new `backend-ts/scripts/verify-erpbridge-registry.mjs`; `backend-ts/package.json`; `backend-ts/tests/erpbridge-registry-compatibility.test.ts`; `backend-ts/README.md`.
  **Verify:** `cd backend-ts && npm test -- --run tests/erpbridge-registry-compatibility.test.ts && npm run verify:erpbridge-registry` against a configured non-production ERPBridge instance. Local Docker ERPBridge authentication and `tools/list` succeeded; the command correctly failed closed with 17 reviewed local tools missing remotely and 16 unreviewed remote tools, without mutating the local registry.

- [ ] **Task 8: Provision and document secure ERPBridge deployment.** Configure `API_AUTH_TOKEN` and use it only to mint/revoke tokens. Mint a named, expiring `erpbt_` service token with only `mcp` scope and exactly the mapped ERP roles; store it in the deployment secret manager as `ERPBRIDGE_MCP_TOKEN`. Configure TLS/service-network access and a rotation/revocation runbook. Add a documented role matrix that maps each engine role, ERPBridge token role, and ERPBridge tool `allowedRoles`; retain workflow user/execution IDs in engine audit logs and state that ERPBridge authenticates the service account rather than the human user.
  **Seam:** ERPBridge token issuance + engine production configuration.
  **Files:** `backend-ts/README.md`; new `backend-ts/docs/ERPBRIDGE_INTEGRATION.md`; `/home/nimendra/Documents/Projects/ERPBridge/docs/tokens.md`; deployment manifests/secret-manager configuration where this stack is deployed.
  **Verify:** create a short-lived token, confirm an allowed MCP tool succeeds, confirm missing `mcp` scope returns 403, revoked token returns 401, and a role absent from either token/tool allow-list is rejected before ERP execution.

- [ ] **Task 9: Run an opt-in end-to-end proof with ERPBridge and mock ERP.** Add a live integration test gated by an explicit environment variable that starts or targets authenticated ERPBridge plus its mock ERP, applies one reviewed read-only tool and one guarded write fixture, and executes workflows through the HTTP API. Verify success for the allowed role, rejection for invalid/missing roles, no duplicate downstream call after injected client transport failure, capability rejection before ERPBridge receives a request, and expected audit/provenance records. Do not run this test by default in unit CI.
  **Seam:** deployed workflow HTTP route → `Executor` → governed ERPBridge adapter → ERPBridge MCP server.
  **Files:** new `backend-ts/tests/integration/erpbridge-mcp.test.ts`; `backend-ts/package.json`; `backend-ts/README.md`; optionally `/home/nimendra/Documents/Projects/ERPBridge/docker-compose.yml` only if a deterministic integration profile is missing.
  **Verify:** `ERPBRIDGE_TEST_SERVER=<url> ERPBRIDGE_MCP_TOKEN=<scoped-token> npm run test:integration`.

- [ ] **Task 10: Prepare, review, and open the linked pull requests.** Keep commits atomic and Conventional Commit-formatted, with one completed task per commit where practical. Update the implementation-branch plan checkboxes only after each task's stated verification is green. Open the SDK PR first with its test/build/publish-lint evidence and release/version reference. After pinning that release, open the workflow-engine PR from `feat/governed-erpbridge-mcp` to `feat/typescript-backend`; include `Refs #1`, the role-matrix decision, the no-retry guarantee, baseline-fixture resolution, test commands/results, and explicit deployment-secret exclusions. Request security review for the capability/identity/role boundary before merge.
  **Seam:** GitHub PR review and CI gates.
  **Files:** `.agents/plans/Plan.md`; `backend-ts/docs/RESULTS.md`; `backend-ts/docs/INVARIANTS.md`; PR descriptions in `nmdra/erpbridge-sdk` and `lksnjw/low-code-workflow-engine`.
  **Verify:** both PRs show a clean diff limited to their scopes, all required CI checks pass, and the workflow-engine PR links to issue #1 without exposing credentials.

## Testing Matrix

| Layer | Purpose | Tests / command | Required outcome |
| --- | --- | --- | --- |
| Baseline | Detect pre-existing fixture drift before functional changes | `cd backend-ts && npm ci && npm test && npm run typecheck` | All tests green after Task 1; record canonical hash provenance. |
| SDK unit | Prove retry policy does not regress default behavior and can disable replay | `cd /home/nimendra/Documents/Projects/erpbridge-sdk && npm test && npm run build && npm run lint:publish` | Default performs one reconnect; `never` makes one outbound tool-call attempt. |
| Config unit | Reject unsafe/incomplete ERPBridge configuration without logging secrets | Focused config tests | Production ERPBridge mode requires endpoint, scoped-token source, and approved role map. |
| Capability contract | Prove invalid dispatches never escape the engine | `npm test -- --run tests/capability.test.ts tests/erpbridge-mcp-client.test.ts` | Forged, expired, reused, parameter-mutated, identity-mismatched, and caller-role calls produce zero SDK calls. |
| Adapter contract | Prove exact action, trusted role injection, MCP error handling, and envelope preservation | `npm test -- --run tests/erpbridge-mcp-client.test.ts` | One valid call; `isError` fails; no arbitrary text parsing; no automatic retry. |
| Registry contract | Detect remote/local schema and exact-name drift without mutation | `npm run verify:erpbridge-registry` against non-production ERPBridge | Drift fails with redact-safe output and leaves the runtime registry byte-identical. |
| Production boundary | Revalidate artifact isolation after adding an SDK dependency | `npm test && npm run build:prod && npm run scan:prod && npm run analyze:boundary && npm run test:prod-inert` | Production bundle stays experiment-free; SDK transport remains reachable only via the governed adapter. |
| Live integration | Exercise authenticated end-to-end behavior against ERPBridge and mock ERP | `ERPBRIDGE_TEST_SERVER=<url> ERPBRIDGE_MCP_TOKEN=<scoped-token> npm run test:integration` | Allowed call succeeds once; auth/RBAC failures fail closed; injected transport failure has no duplicate downstream invocation. |

## Verification

1. `backend-ts` is green before and after integration: typecheck, unit tests, production build, forbidden-content scan, boundary analysis, and production-inert test all pass.
2. Every pre-existing capability rejection case remains transport-free; new identity/role mismatch and caller-supplied-role cases are also transport-free.
3. A valid guarded workflow produces one MCP `tools/call` with the reviewed remote tool name and only the capability-bound role selector.
4. An allowed role succeeds; an unmapped role, a token missing `mcp`, a token without the selected role, and a tool without that allowed role all fail closed.
5. The workflow engine never contains an ERPBridge admin credential and never calls `/api/tools/invoke` for execution.
6. A transport failure produces no automatic second tool call. The execution is reported failed/ambiguous until future idempotency work exists.
7. Registry compatibility drift fails CI/deployment but cannot mutate or automatically enable the local runtime registry.
8. The opt-in environment proves the authenticated path against ERPBridge and mock ERP; normal tests remain hermetic and do not require credentials.

## Open Questions

1. **Role vocabulary:** Which exact workflow-engine role names map to ERPBridge roles? The implementation should not start until the production role matrix is approved; the configuration map must be total for every role allowed to execute ERPBridge-managed tools.
2. **Output contract:** Should ERPBridge MCP envelopes remain visible as complete step outputs (recommended for fidelity), or should an approved per-tool output adapter expose a normalized business object? Do not parse arbitrary MCP text content globally.
3. **SDK release process:** Resolved. Pin the published `@erpbridge/sdk@1.1.0` package; do not depend on the sibling checkout or the feature branch.
