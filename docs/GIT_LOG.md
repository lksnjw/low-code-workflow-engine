# Complete Git History

Generated: 2026-08-20  
Scope: every unique commit reachable from local and remote refs via `git log --all`  
Unique commits: **79**  
Commits reachable from `main`: **77**  
Current branch: `main`  
Current HEAD: `94022e9f60758c152b3fca79978a9acbdb9396f9`  
Root commit: `5ee79bcc2153d27e5d79373c95f64a83e78b076b`

This document records the repository refs, decorated commit graph, complete commit metadata and messages, and per-commit file/insertion/deletion statistics. It is a generated historical record; source changes remain authoritative in Git.

## Branch and Remote Ref Inventory

```text
feat/day4-model-independence -> 59704f7 fix: surface workflow final output (and partial output on failure)
feat/experiment-readiness -> b591d96 add evaluation dataset generator + 120 labelled cases
feat/final-consolidation -> 6876e71 consolidate thesis evidence and safety invariants
feat/g1-g2-gate-invariant -> bf78689 Update Readme.md
feat/g1-restore-mediation -> 59704f7 fix: surface workflow final output (and partial output on failure)
feat/g4a-sod-rule -> 59704f7 fix: surface workflow final output (and partial output on failure)
feat/part3-bulk-import-md -> 3bc7ade registry: atomic bulk import + generation-context MD (never gates)
feat/part4-analysis-steps -> b2eadf5 Add standalone mock ERP demo integration
feat/quick-wins -> f24790e test: isolate execution log redaction fixture
feat/role-portals -> 4805242 fix(auth): persist rotated refresh token, prevent logout after refresh
fix/contract-frontend -> 94022e9 docs: frontend/backend contract audit
fix/eval-registry-baseline -> 59704f7 fix: surface workflow final output (and partial output on failure)
fix/part2-auth-and-lint -> 6b6181d fix(part2): lint clean, 403→auth-denied terminal, no raw error leaks
fix/workflow-output-display -> 59704f7 fix: surface workflow final output (and partial output on failure)
intergration -> 1d84e6a Create README.md
main -> 94022e9 docs: frontend/backend contract audit
validator_checking -> 43714e5 aadding the files to cha chat
workflow_generation -> 66bd091 prepare repository for GitHub push
origin -> 94022e9 docs: frontend/backend contract audit
origin/feat/day4-model-independence -> 59704f7 fix: surface workflow final output (and partial output on failure)
origin/feat/experiment-readiness -> b591d96 add evaluation dataset generator + 120 labelled cases
origin/feat/final-consolidation -> 6876e71 consolidate thesis evidence and safety invariants
origin/feat/g1-restore-mediation -> 59704f7 fix: surface workflow final output (and partial output on failure)
origin/feat/g4a-sod-rule -> 59704f7 fix: surface workflow final output (and partial output on failure)
origin/feat/part4-analysis-steps -> b2eadf5 Add standalone mock ERP demo integration
origin/feat/role-portals -> 8a290d9 Add runtime registry import and context pipeline
origin/fix/contract-frontend -> 94022e9 docs: frontend/backend contract audit
origin/fix/eval-registry-baseline -> 59704f7 fix: surface workflow final output (and partial output on failure)
origin/intergration -> 1d84e6a Create README.md
origin/main -> 94022e9 docs: frontend/backend contract audit
origin/validator_checking -> 43714e5 aadding the files to cha chat
origin/workflow_generation -> 66bd091 prepare repository for GitHub push
```

## Decorated Commit Graph

```text
* 94022e9 2026-08-20T12:29:22+05:30  (HEAD -> main, origin/main, origin/fix/contract-frontend, origin/HEAD, fix/contract-frontend) docs: frontend/backend contract audit [LakshanSanjeewa]
* 694f5a1 2026-08-20T12:10:37+05:30  fix(frontend): align permission constants [LakshanSanjeewa]
* d2c8f09 2026-08-20T12:08:28+05:30  fix(frontend): preserve unknown status labels [LakshanSanjeewa]
* 5c50c85 2026-08-20T12:06:56+05:30  fix(frontend): reserve unreachable state for transport errors [LakshanSanjeewa]
* 1237c49 2026-08-20T12:05:18+05:30  fix(frontend): disclose audit result total [LakshanSanjeewa]
* 419ba82 2026-08-20T12:03:35+05:30  fix(frontend): show backend resource errors [LakshanSanjeewa]
* b5b9a9a 2026-08-20T12:02:15+05:30  fix(frontend): explain workflow gate rejections [LakshanSanjeewa]
* f24790e 2026-08-20T11:03:01+05:30  (feat/quick-wins) test: isolate execution log redaction fixture [LakshanSanjeewa]
* c3cf392 2026-08-20T10:55:08+05:30  docs: align supported product surface [LakshanSanjeewa]
* e58b9e8 2026-08-20T10:39:24+05:30  fix: reject malformed map request bodies [LakshanSanjeewa]
* 5a7b898 2026-08-20T10:25:28+05:30  fix: align frontend actions with permissions [LakshanSanjeewa]
* 323fe1b 2026-08-20T10:16:53+05:30  feat: record prompt and completion provenance [LakshanSanjeewa]
* 45bda36 2026-08-20T10:10:27+05:30  fix: redact execution log metadata [LakshanSanjeewa]
* d310641 2026-08-20T09:57:02+05:30  docs: add evidence-backed system map [LakshanSanjeewa]
* 6876e71 2026-08-20T07:12:38+05:30  (origin/feat/final-consolidation, feat/final-consolidation) consolidate thesis evidence and safety invariants [LakshanSanjeewa]
* 59704f7 2026-08-03T14:12:58+05:30  (origin/fix/eval-registry-baseline, origin/feat/g4a-sod-rule, origin/feat/g1-restore-mediation, origin/feat/day4-model-independence, fix/workflow-output-display, fix/eval-registry-baseline, feat/g4a-sod-rule, feat/g1-restore-mediation, feat/day4-model-independence) fix: surface workflow final output (and partial output on failure) [LakshanSanjeewa]
* b2eadf5 2026-08-03T12:07:55+05:30  (origin/feat/part4-analysis-steps, feat/part4-analysis-steps) Add standalone mock ERP demo integration [LakshanSanjeewa]
* de161ca 2026-08-02T22:48:46+05:30  execution: analysis steps with data-egress validation (Part 4) [LakshanSanjeewa]
* 3bc7ade 2026-08-02T22:11:03+05:30  (feat/part3-bulk-import-md) registry: atomic bulk import + generation-context MD (never gates) [LakshanSanjeewa]
* 6b6181d 2026-08-02T21:38:37+05:30  (fix/part2-auth-and-lint) fix(part2): lint clean, 403→auth-denied terminal, no raw error leaks [LakshanSanjeewa]
* 4805242 2026-08-02T20:33:42+05:30  (feat/role-portals) fix(auth): persist rotated refresh token, prevent logout after refresh [LakshanSanjeewa]
* 4d4af0c 2026-08-02T20:12:35+05:30  generation: grounded, schema-constrained prompting + accuracy report [LakshanSanjeewa]
* 8a290d9 2026-07-26T12:18:51+05:30  (origin/feat/role-portals) Add runtime registry import and context pipeline [LakshanSanjeewa]
* cd6bec2 2026-07-25T09:00:11+05:30  Refactor routing and harden execution failures [LakshanSanjeewa]
* a0f8da8 2026-07-25T01:06:43+05:30  Add architecture map reconnaissance doc [LakshanSanjeewa]
* 569b294 2026-07-25T00:39:19+05:30  Harden RBAC and bootstrap admin provisioning [LakshanSanjeewa]
* ebb8bb7 2026-07-22T23:04:19+05:30  bootstrap: system_admin role, live permission derivation, seed data [LakshanSanjeewa]
* 726de7a 2026-07-22T22:21:07+05:30  verify postgres persistence end-to-end [LakshanSanjeewa]
* 9ef12be 2026-07-21T09:51:09+05:30  feat(persistence): dual-mode storage with encrypted Postgres snapshot + bootstrap [LakshanSanjeewa]
* 0d1fd49 2026-07-20T23:58:41+05:30  metrics: preserve provider token usage metadata [LakshanSanjeewa]
* 9494ee1 2026-07-20T23:43:32+05:30  demo: client-runnable tool, mock MCP mode, lexical fallback, DEMO.md [LakshanSanjeewa]
* 23a34e1 2026-07-20T23:21:37+05:30  fix(s5): bind catalog toolGroups query in writable builder [LakshanSanjeewa]
* 26cd7b9 2026-07-20T23:16:01+05:30  experiment: gate-on vs gate-off harness + metrics over 120 cases [LakshanSanjeewa]
* e7300c0 2026-07-20T22:59:24+05:30  security: remove committed key, header auth, no secret echo [LakshanSanjeewa]
* da35d0f 2026-07-20T02:46:04+05:30  docs: record role portal implementation result [LakshanSanjeewa]
* 3d06105 2026-07-20T02:42:23+05:30  slice5: role-aware screen modes [LakshanSanjeewa]
* 99bec43 2026-07-20T02:32:20+05:30  slice4: client scoping + workflow assignment [LakshanSanjeewa]
* 889873e 2026-07-20T02:21:11+05:30  slice3: runtime provider configs with write-only keys [LakshanSanjeewa]
* 0d501a4 2026-07-20T02:10:18+05:30  slice2: runtime tool/rule registry CRUD with atomic reload [LakshanSanjeewa]
* b12dece 2026-07-20T01:58:49+05:30  slice1: client role + frontend role gating [LakshanSanjeewa]
* b591d96 2026-07-20T00:57:38+05:30  (origin/feat/experiment-readiness, feat/experiment-readiness) add evaluation dataset generator + 120 labelled cases [LakshanSanjeewa]
* 17a4f9b 2026-07-20T00:48:27+05:30  add Baseline B experiment mode [LakshanSanjeewa]
* 43a384c 2026-07-20T00:41:20+05:30  verify G1/G2 [LakshanSanjeewa]
* bf78689 2026-05-12T20:29:39+05:30  (feat/g1-g2-gate-invariant) Update Readme.md [lakshan sanjeewa]
* 34efe14 2026-05-12T20:28:29+05:30  Create Readme.md [lakshan sanjeewa]
| * e6287b1 2026-05-12T20:24:33+05:30  (refs/stash) On main: !!GitHub_Desktop<main> [LakshanSanjeewa]
|/| 
| * 6da02b8 2026-05-12T20:24:33+05:30  index on main: 1d84e6a Create README.md [LakshanSanjeewa]
|/  
* 1d84e6a 2026-05-12T20:23:05+05:30  (origin/intergration, intergration) Create README.md [LakshanSanjeewa]
* a8ec62a 2026-05-10T23:29:30+05:30  Add comprehensive backend documentation [LakshanSanjeewa]
* db7a7f1 2026-05-10T17:24:58+05:30  Add datafeed pages and improve bridge/finetune UI [LakshanSanjeewa]
* 3607e32 2026-05-10T16:39:05+05:30  Add test-report target and generated artifacts [LakshanSanjeewa]
* 67544d2 2026-05-10T14:23:36+05:30  adding approval like things [LakshanSanjeewa]
* f995c11 2026-05-10T11:43:11+05:30  Add auth flow, token refresh & chat UI updates [LakshanSanjeewa]
* 43714e5 2026-05-10T10:08:19+05:30  (origin/validator_checking, validator_checking) aadding the files to cha chat [LakshanSanjeewa]
* a05b51a 2026-05-09T20:07:10+05:30  Update chat_orchestrator.go [LakshanSanjeewa]
* 0725617 2026-05-09T18:12:13+05:30  optimizing the workflow and the data set [LakshanSanjeewa]
* 096b4c6 2026-05-09T09:36:11+05:30  updating the ui for componet wise [LakshanSanjeewa]
* 69e5837 2026-05-09T04:13:30+05:30  Trigger sync workflow [LakshanSanjeewa]
* 24833d0 2026-05-09T03:56:05+05:30  Add auto sync workflow to main repository [LakshanSanjeewa]
* 66bd091 2026-05-08T10:00:00+05:30  (origin/workflow_generation, workflow_generation) prepare repository for GitHub push [LakshanSanjeewa]
* 35d8821 2026-05-06T10:00:00+05:30  add semantic validation dataset [LakshanSanjeewa]
* 00a4c9c 2026-05-04T10:00:00+05:30  add API documentation [LakshanSanjeewa]
* e54cd91 2026-05-02T10:00:00+05:30  add tests [LakshanSanjeewa]
* aabec4e 2026-04-30T10:00:00+05:30  add settings profile integrations and notifications [LakshanSanjeewa]
* 2577df9 2026-04-27T10:00:00+05:30  add frontend execution monitoring [LakshanSanjeewa]
* dbfd62b 2026-04-24T10:00:00+05:30  add frontend chat and synthesis UI [LakshanSanjeewa]
* 08c659f 2026-04-21T10:00:00+05:30  add frontend workflow builder [LakshanSanjeewa]
* 7e767e2 2026-04-18T10:00:00+05:30  add frontend dashboard and analytics [LakshanSanjeewa]
* 610b987 2026-04-15T10:00:00+05:30  add frontend auth and users [LakshanSanjeewa]
* a9c2064 2026-04-13T10:00:00+05:30  add frontend shared UI components [LakshanSanjeewa]
* 3963fdf 2026-04-11T10:00:00+05:30  add frontend app shell and routing [LakshanSanjeewa]
* 10c6d49 2026-04-09T10:00:00+05:30  add backend MCP tools integration [LakshanSanjeewa]
* 005e9c1 2026-04-07T10:00:00+05:30  add backend synthesis and validation [LakshanSanjeewa]
* dcdae85 2026-04-05T10:00:00+05:30  add backend workflow runner [LakshanSanjeewa]
* e5616d2 2026-04-03T10:00:00+05:30  add backend API routes and handlers [LakshanSanjeewa]
* e7edcec 2026-04-01T10:00:00+05:30  add backend data models and repositories [LakshanSanjeewa]
* b406e56 2026-03-29T10:00:00+05:30  add frontend project scaffold [LakshanSanjeewa]
* 6c35da7 2026-03-27T10:00:00+05:30  add backend project scaffold [LakshanSanjeewa]
* 5ee79bc 2026-03-25T09:30:00+05:30  initialize project repository settings [LakshanSanjeewa]
```

## Detailed Commit Log

```text
commit 94022e9f60758c152b3fca79978a9acbdb9396f9
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-08-20T12:29:22+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-08-20T12:29:22+05:30
Parents: 694f5a1cbc7fee271f8d412865ef0405b7224095
Refs: HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/fix/contract-frontend, refs/remotes/origin/HEAD, refs/heads/fix/contract-frontend
Subject: docs: frontend/backend contract audit



 6 files changed, 365 insertions(+)
commit 694f5a1cbc7fee271f8d412865ef0405b7224095
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-08-20T12:10:37+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-08-20T12:10:37+05:30
Parents: d2c8f09236064f55aa57472fcba6d6d35987d9f7
Refs: 
Subject: fix(frontend): align permission constants



 3 files changed, 64 insertions(+), 34 deletions(-)
commit d2c8f09236064f55aa57472fcba6d6d35987d9f7
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-08-20T12:08:28+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-08-20T12:08:28+05:30
Parents: 5c50c8566e9534f5223b4bd8f31bb0ec80cc7a83
Refs: 
Subject: fix(frontend): preserve unknown status labels



 4 files changed, 31 insertions(+), 4 deletions(-)
commit 5c50c8566e9534f5223b4bd8f31bb0ec80cc7a83
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-08-20T12:06:56+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-08-20T12:06:56+05:30
Parents: 1237c498480a6ee7f0cddac12361a2fa344411e3
Refs: 
Subject: fix(frontend): reserve unreachable state for transport errors



 2 files changed, 24 insertions(+), 36 deletions(-)
commit 1237c498480a6ee7f0cddac12361a2fa344411e3
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-08-20T12:05:18+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-08-20T12:05:18+05:30
Parents: 419ba82e6d89df3ea0b25994abcd35dee0145ff3
Refs: 
Subject: fix(frontend): disclose audit result total



 4 files changed, 55 insertions(+), 4 deletions(-)
commit 419ba82e6d89df3ea0b25994abcd35dee0145ff3
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-08-20T12:03:35+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-08-20T12:03:35+05:30
Parents: b5b9a9a5d892719f28e158905046ef6adb2891d5
Refs: 
Subject: fix(frontend): show backend resource errors



 2 files changed, 32 insertions(+), 2 deletions(-)
commit b5b9a9a5d892719f28e158905046ef6adb2891d5
Author: LakshanSanjeewa <lakshan.s@boswingroup.com>
AuthorDate: 2026-08-20T12:02:15+05:30
Committer: LakshanSanjeewa <lakshan.s@boswingroup.com>
CommitDate: 2026-08-20T12:02:15+05:30
Parents: f24790ef3e31355aa76064ca29f2c03e5ae0d519
Refs: 
Subject: fix(frontend): explain workflow gate rejections



 5 files changed, 139 insertions(+), 5 deletions(-)
commit f24790ef3e31355aa76064ca29f2c03e5ae0d519
Author: LakshanSanjeewa <lakshan.s@boswingroup.com>
AuthorDate: 2026-08-20T11:03:01+05:30
Committer: LakshanSanjeewa <lakshan.s@boswingroup.com>
CommitDate: 2026-08-20T11:03:01+05:30
Parents: c3cf3923ecdf5d5276f4e9aede5b20038a9ed80d
Refs: refs/heads/feat/quick-wins
Subject: test: isolate execution log redaction fixture



 2 files changed, 15 insertions(+), 7 deletions(-)
commit c3cf3923ecdf5d5276f4e9aede5b20038a9ed80d
Author: LakshanSanjeewa <lakshan.s@boswingroup.com>
AuthorDate: 2026-08-20T10:55:08+05:30
Committer: LakshanSanjeewa <lakshan.s@boswingroup.com>
CommitDate: 2026-08-20T10:55:08+05:30
Parents: e58b9e8e08b025a761f1566d2a96c8aa9e916d21
Refs: 
Subject: docs: align supported product surface



 26 files changed, 253 insertions(+), 78 deletions(-)
commit e58b9e8e08b025a761f1566d2a96c8aa9e916d21
Author: LakshanSanjeewa <lakshan.s@boswingroup.com>
AuthorDate: 2026-08-20T10:39:24+05:30
Committer: LakshanSanjeewa <lakshan.s@boswingroup.com>
CommitDate: 2026-08-20T10:39:24+05:30
Parents: 5a7b8983d5650330fc92a6b7bbd3d7ecf4066780
Refs: 
Subject: fix: reject malformed map request bodies



 13 files changed, 172 insertions(+), 43 deletions(-)
commit 5a7b8983d5650330fc92a6b7bbd3d7ecf4066780
Author: LakshanSanjeewa <lakshan.s@boswingroup.com>
AuthorDate: 2026-08-20T10:25:28+05:30
Committer: LakshanSanjeewa <lakshan.s@boswingroup.com>
CommitDate: 2026-08-20T10:25:28+05:30
Parents: 323fe1bb17978ab4eadd473b175044d180501a49
Refs: 
Subject: fix: align frontend actions with permissions



 7 files changed, 157 insertions(+), 12 deletions(-)
commit 323fe1bb17978ab4eadd473b175044d180501a49
Author: LakshanSanjeewa <lakshan.s@boswingroup.com>
AuthorDate: 2026-08-20T10:16:53+05:30
Committer: LakshanSanjeewa <lakshan.s@boswingroup.com>
CommitDate: 2026-08-20T10:16:53+05:30
Parents: 45bda36633c978cc2f944477debdb48ef0cad7b6
Refs: 
Subject: feat: record prompt and completion provenance



 5 files changed, 109 insertions(+)
commit 45bda36633c978cc2f944477debdb48ef0cad7b6
Author: LakshanSanjeewa <lakshan.s@boswingroup.com>
AuthorDate: 2026-08-20T10:10:27+05:30
Committer: LakshanSanjeewa <lakshan.s@boswingroup.com>
CommitDate: 2026-08-20T10:10:27+05:30
Parents: d310641a562a2a6ae2cfa64d2677145f66e3f512
Refs: 
Subject: fix: redact execution log metadata



 7 files changed, 139 insertions(+), 54 deletions(-)
commit d310641a562a2a6ae2cfa64d2677145f66e3f512
Author: LakshanSanjeewa <lakshan.s@boswingroup.com>
AuthorDate: 2026-08-20T09:57:02+05:30
Committer: LakshanSanjeewa <lakshan.s@boswingroup.com>
CommitDate: 2026-08-20T09:57:02+05:30
Parents: 6876e719686b4718d858bbe32ddda32404051c2d
Refs: 
Subject: docs: add evidence-backed system map



 4 files changed, 383 insertions(+)
commit 6876e719686b4718d858bbe32ddda32404051c2d
Author: LakshanSanjeewa <lakshan.s@boswingroup.com>
AuthorDate: 2026-08-20T07:12:38+05:30
Committer: LakshanSanjeewa <lakshan.s@boswingroup.com>
CommitDate: 2026-08-20T07:12:38+05:30
Parents: 59704f70fdf327b7680eeaadbd8b1bf0dd83d504
Refs: refs/remotes/origin/feat/final-consolidation, refs/heads/feat/final-consolidation
Subject: consolidate thesis evidence and safety invariants



 80 files changed, 4607 insertions(+), 973 deletions(-)
commit 59704f70fdf327b7680eeaadbd8b1bf0dd83d504
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-08-03T14:12:58+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-08-03T14:12:58+05:30
Parents: b2eadf5f6e3159442416abbd92dc0fb71407644f
Refs: refs/remotes/origin/fix/eval-registry-baseline, refs/remotes/origin/feat/g4a-sod-rule, refs/remotes/origin/feat/g1-restore-mediation, refs/remotes/origin/feat/day4-model-independence, refs/heads/fix/workflow-output-display, refs/heads/fix/eval-registry-baseline, refs/heads/feat/g4a-sod-rule, refs/heads/feat/g1-restore-mediation, refs/heads/feat/day4-model-independence
Subject: fix: surface workflow final output (and partial output on failure)

The runner already captured every step's output: StateManager.Save records the
tool result (executor.go:187) and the analysis result (executor.go:122), and
Snapshot returns the live variables map, so Result.State accumulates outputs
even when a run stops early. Nothing consumed it. Result.State was assigned at
executor.go:196 and read nowhere else in the codebase, so the handler dropped
it, models.Execution had no field to hold it, the detail endpoint could not
return it, and the UI had nothing to bind to.

Per-step tool output did survive incidentally inside ExecutionLog.Metadata,
but LiveLogStream renders only timestamp/level/nodeId/message and discards
metadata; analysis output was not in metadata at all, so it was lost outright.

Fix, at the link that was broken:
- models: additive StepOutputs/FinalOutput on Execution and Output on
  ExecutionStep. The status enum is unchanged.
- execute_handler: join Result.State onto the timeline by step id, record the
  per-step outputs and the final output (the last step that completed, so a
  failed run still reports what it produced), and strip credential-shaped
  fields with the existing withoutNestedSecretFields redactor.
- frontend: ExecutionOutputPanel renders the final output for a completed run
  and partial output plus a "stopped early" badge for a failed one, with
  truncation and a view-full toggle for large payloads.

Gate and dispatch logic are untouched: no change to the validator, the runner,
the experiment harness or the dataset. Gate-ON 54/0/60/6, recall 0.9000,
precision 1.0000; gate-OFF 0.0000/60 — unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>


 7 files changed, 454 insertions(+), 3 deletions(-)
commit b2eadf5f6e3159442416abbd92dc0fb71407644f
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-08-03T12:07:55+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-08-03T12:07:55+05:30
Parents: de161ca8f83b6a1e3761496df26d41d7eee35b80
Refs: refs/remotes/origin/feat/part4-analysis-steps, refs/heads/feat/part4-analysis-steps
Subject: Add standalone mock ERP demo integration

Introduces a full standalone `cmd/mock-erp` service with seeded fixtures, schema-aware tool execution, failure injection, reset/health endpoints, and tests, then wires server startup to detect/mock-ERP backends and expose MCP backend mode in health data. Hardens API behavior by redacting company data for non-admins, restricting execution retry to readable executions, adding failure-category and retry coverage, and aligning importer validation with registry loader rules. Updates frontend execution UX to distinguish governance blocks from tool failures, improves auth/network resilience (no logout on backend outages, retry banner, shared refresh race handling), filters command palette links by permission, and adds extensive demo/integration documentation plus a one-command mock demo startup script.


 64 files changed, 6329 insertions(+), 332 deletions(-)
commit de161ca8f83b6a1e3761496df26d41d7eee35b80
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-08-02T22:48:46+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-08-02T22:48:46+05:30
Parents: 3bc7ade3c8c33523bf6c1fbb6670d3ea00794676
Refs: 
Subject: execution: analysis steps with data-egress validation (Part 4)



 13 files changed, 1230 insertions(+), 14 deletions(-)
commit 3bc7ade3c8c33523bf6c1fbb6670d3ea00794676
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-08-02T22:11:03+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-08-02T22:11:03+05:30
Parents: 6b6181ddf012f25d08287996f1fb51cae6008380
Refs: refs/heads/feat/part3-bulk-import-md
Subject: registry: atomic bulk import + generation-context MD (never gates)



 13 files changed, 997 insertions(+), 1 deletion(-)
commit 6b6181ddf012f25d08287996f1fb51cae6008380
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-08-02T21:38:37+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-08-02T21:38:37+05:30
Parents: 4805242928c0024ef9073f9b2ac42b3812aace8b
Refs: refs/heads/fix/part2-auth-and-lint
Subject: fix(part2): lint clean, 403→auth-denied terminal, no raw error leaks



 7 files changed, 415 insertions(+), 36 deletions(-)

commit 4805242928c0024ef9073f9b2ac42b3812aace8b
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-08-02T20:33:42+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-08-02T20:33:42+05:30
Parents: 4d4af0cb724e424abdcbe2f1c975ae8a5ee7951e
Refs: refs/heads/feat/role-portals
Subject: fix(auth): persist rotated refresh token, prevent logout after refresh



 2 files changed, 88 insertions(+), 7 deletions(-)
commit 4d4af0cb724e424abdcbe2f1c975ae8a5ee7951e
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-08-02T20:12:35+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-08-02T20:12:35+05:30
Parents: 8a290d90615fc6bd00029e7c7b59bdfef88e9738
Refs: 
Subject: generation: grounded, schema-constrained prompting + accuracy report



 10 files changed, 868 insertions(+), 100 deletions(-)
commit 8a290d90615fc6bd00029e7c7b59bdfef88e9738
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-07-26T12:18:51+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-07-26T12:18:51+05:30
Parents: cd6bec27e69c0ce1b625211b935b368637b4f908
Refs: refs/remotes/origin/feat/role-portals
Subject: Add runtime registry import and context pipeline

This change separates mutable runtime registries from frozen evaluation registries and enforces that boundary across server startup, CRUD, import, and docs. It adds first-boot runtime seeding, registry status/hash reporting, and guards that block writes to `configs/registries`.

It also introduces a full bulk import workflow (analyse/commit/history) with strict schema validation, OpenAPI normalization, deterministic diffs, rollback-safe commits, and audit/history tracking, plus generated registry Markdown context with versioned history and regeneration hooks.

Additional updates add company profile/domain modeling and APIs, department-aware user assignment, workflow domain-tag derivation and relevance filtering, and frontend pages/components for Company, Registry Import, and Registry Context, along with UI/service updates and expanded backend/frontend tests.


 78 files changed, 7685 insertions(+), 280 deletions(-)
commit cd6bec27e69c0ce1b625211b935b368637b4f908
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-07-25T09:00:11+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-07-25T09:00:11+05:30
Parents: a0f8da831480e9a9408c5b31eefea3007a73c265
Refs: 
Subject: Refactor routing and harden execution failures

Migrated the frontend to a React Router-based route map with lazy-loaded pages, deep-link support, per-view page variants, stronger error boundaries, and new route/error tests. Updated execution handling to return explicit 422 failures with step/tool context, keep healing outcomes terminal, reconcile orphaned RUNNING executions on startup, and compute success metrics from all terminal states. Also tightened user-facing error messages and adjusted integration/invariant tests to match the new behavior.


 59 files changed, 1573 insertions(+), 1079 deletions(-)
commit a0f8da831480e9a9408c5b31eefea3007a73c265
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-07-25T01:06:43+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-07-25T01:06:43+05:30
Parents: 569b29407eb4f4592ade929959d664ff5e9f0007
Refs: 
Subject: Add architecture map reconnaissance doc

Introduce `docs/ARCHITECTURE_MAP.md` as a comprehensive snapshot of the current `feat/role-portals` codebase. It documents backend/frontend structure, route and middleware behavior, runtime flows, persistence models, validation and registry mechanics, known gaps, and recorded build/test outcomes to provide a single reference for system understanding.


 1 file changed, 1674 insertions(+)
commit 569b29407eb4f4592ade929959d664ff5e9f0007
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-07-25T00:39:19+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-07-25T00:39:19+05:30
Parents: ebb8bb7f84bc46a7f3d629fa5e7471cccd79d4bf
Refs: 
Subject: Harden RBAC and bootstrap admin provisioning

Replaces first-user/bootstrap-token registration with startup-only Platform Admin bootstrapping via `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`, using a shared password hashing path. Refactors user authorization to derive effective role/permissions from role IDs (with persistence migration), adds stronger anti-escalation/admin-guard checks, and splits provider/registry access into explicit `provider:manage`, `registry:read`, and `registry:write` permissions. Updates routes, docs, and tests accordingly, and expands the frontend Users/Registry UX with role create/edit/delete flows, user role/status actions, and permission-filtered controls.


 54 files changed, 2026 insertions(+), 564 deletions(-)
commit ebb8bb7f84bc46a7f3d629fa5e7471cccd79d4bf
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-07-22T23:04:19+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-07-22T23:04:19+05:30
Parents: 726de7a5391cacfb59d4079fdc1adaf80e77bfa3
Refs: 
Subject: bootstrap: system_admin role, live permission derivation, seed data



 22 files changed, 1309 insertions(+), 68 deletions(-)
commit 726de7a5391cacfb59d4079fdc1adaf80e77bfa3
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-07-22T22:21:07+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-07-22T22:21:07+05:30
Parents: 9ef12be99de4d8024e38575184d71c32183c81e1
Refs: 
Subject: verify postgres persistence end-to-end



 1 file changed, 249 insertions(+)
commit 9ef12be99de4d8024e38575184d71c32183c81e1
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-07-21T09:51:09+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-07-21T09:51:09+05:30
Parents: 0d1fd49d0e9682ca81d5bb6c4ca2fbeda8059a31
Refs: 
Subject: feat(persistence): dual-mode storage with encrypted Postgres snapshot + bootstrap

Land the Part 4 persistence work (P0-P5) plus the deployment and bootstrap
wiring that goes with it. STORAGE_DRIVER selects process-local memory
(default) or an AES-256-GCM encrypted PostgreSQL whole-state snapshot with a
lifetime single-writer advisory lock. The safety gate is unchanged: validation
token, dispatch-time recheck, and Baseline B experiment-only gating all remain.

Storage:
- internal/storage: driver selection, AES-256-GCM codec (fresh nonce,
  authenticated magic prefix, strict 32-byte key), pgx pool, transactional
  embedded migration, encrypted upsert/load/probe.
- repository/persistent_store: versioned state DTO, hidden-field preservation,
  synchronous save, rollback-to-committed on failed save, failure generation.
- Postgres integration tests skip without TEST_DATABASE_URL.

API/runtime:
- persistence middleware serializes durable HTTP mutations and returns
  retriable 503 on a failed save so an uncommitted mutation is not acknowledged.
- rate_limit middleware bounds auth mutations per IP+path with Retry-After.
- auth: secure first-admin bootstrap, active-user login/refresh checks,
  atomic durable registration that rolls back and returns 503 on save failure.
- config: STORAGE_DRIVER/STORAGE_ENCRYPTION_KEY/BOOTSTRAP_ADMIN_TOKEN with
  fail-closed production validation.

Deployment/docs:
- Dockerfiles, docker-compose (postgres, redis, backend, frontend), nginx
  same-origin /api + /ws proxy, entrypoint that seeds registry JSON.
- docs/BOOTSTRAP_FLOW.md memory/postgres bootstrap + restart runbook.
- CURRENT_STATE.md completion report.
- Remove stale tracked artifacts (log zip, src zip, python bytecode).

Gates: go build/vet/test ./... pass (postgres integration tests skip without a
live DB); npm test (9 suites) and npm run build pass. Not pushed: the historical
Gemini key in git history still requires owner revocation before publishing.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>


 81 files changed, 3746 insertions(+), 394 deletions(-)
commit 0d1fd49d0e9682ca81d5bb6c4ca2fbeda8059a31
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-07-20T23:58:41+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-07-20T23:58:41+05:30
Parents: 9494ee1ef9488e869923929f8ebf0e2acca62d11
Refs: 
Subject: metrics: preserve provider token usage metadata



 6 files changed, 316 insertions(+), 47 deletions(-)
commit 9494ee1ef9488e869923929f8ebf0e2acca62d11
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-07-20T23:43:32+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-07-20T23:43:32+05:30
Parents: 23a34e14fd91ab27dbee50c1e8d8378c25a00cfb
Refs: 
Subject: demo: client-runnable tool, mock MCP mode, lexical fallback, DEMO.md



 16 files changed, 1063 insertions(+), 10 deletions(-)
commit 23a34e14fd91ab27dbee50c1e8d8378c25a00cfb
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-07-20T23:21:37+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-07-20T23:21:37+05:30
Parents: 26cd7b94e5ae6645b350698381429b1b6efe272d
Refs: 
Subject: fix(s5): bind catalog toolGroups query in writable builder



 7 files changed, 1439 insertions(+), 164 deletions(-)
commit 26cd7b94e5ae6645b350698381429b1b6efe272d
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-07-20T23:16:01+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-07-20T23:16:01+05:30
Parents: e7300c0a7c0e51620d2b54036fe69fd34fea76d0
Refs: 
Subject: experiment: gate-on vs gate-off harness + metrics over 120 cases



 7 files changed, 915 insertions(+), 2 deletions(-)
commit e7300c0a7c0e51620d2b54036fe69fd34fea76d0
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-07-20T22:59:24+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-07-20T22:59:24+05:30
Parents: da35d0f4e6215f954b2a7a0ef1897819bf87c02d
Refs: 
Subject: security: remove committed key, header auth, no secret echo



 6 files changed, 281 insertions(+), 13 deletions(-)
commit da35d0f4e6215f954b2a7a0ef1897819bf87c02d
Author: LakshanSanjeewa <lakshan.s@boswingroup.com>
AuthorDate: 2026-07-20T02:46:04+05:30
Committer: LakshanSanjeewa <lakshan.s@boswingroup.com>
CommitDate: 2026-07-20T02:46:04+05:30
Parents: 3d0610521f902c812d66ce175c8506896da09617
Refs: 
Subject: docs: record role portal implementation result



 2 files changed, 493 insertions(+)
commit 3d0610521f902c812d66ce175c8506896da09617
Author: LakshanSanjeewa <lakshan.s@boswingroup.com>
AuthorDate: 2026-07-20T02:42:23+05:30
Committer: LakshanSanjeewa <lakshan.s@boswingroup.com>
CommitDate: 2026-07-20T02:42:23+05:30
Parents: 99bec43a12cce96676796db5385cc0933f47288a
Refs: 
Subject: slice5: role-aware screen modes



 10 files changed, 201 insertions(+), 54 deletions(-)
commit 99bec43a12cce96676796db5385cc0933f47288a
Author: LakshanSanjeewa <lakshan.s@boswingroup.com>
AuthorDate: 2026-07-20T02:32:20+05:30
Committer: LakshanSanjeewa <lakshan.s@boswingroup.com>
CommitDate: 2026-07-20T02:32:20+05:30
Parents: 889873ef275c6f8dc25da851b3500ee5a323e9b5
Refs: 
Subject: slice4: client scoping + workflow assignment



 17 files changed, 479 insertions(+), 40 deletions(-)
commit 889873ef275c6f8dc25da851b3500ee5a323e9b5
Author: LakshanSanjeewa <lakshan.s@boswingroup.com>
AuthorDate: 2026-07-20T02:21:11+05:30
Committer: LakshanSanjeewa <lakshan.s@boswingroup.com>
CommitDate: 2026-07-20T02:21:11+05:30
Parents: 0d501a4813565c76c5c5d0e3297a316366639ec8
Refs: 
Subject: slice3: runtime provider configs with write-only keys



 15 files changed, 694 insertions(+), 23 deletions(-)
commit 0d501a4813565c76c5c5d0e3297a316366639ec8
Author: LakshanSanjeewa <lakshan.s@boswingroup.com>
AuthorDate: 2026-07-20T02:10:18+05:30
Committer: LakshanSanjeewa <lakshan.s@boswingroup.com>
CommitDate: 2026-07-20T02:10:18+05:30
Parents: b12decee9e5a57030ff7c926c21cc3ff63757fe7
Refs: 
Subject: slice2: runtime tool/rule registry CRUD with atomic reload



 13 files changed, 891 insertions(+), 5 deletions(-)
commit b12decee9e5a57030ff7c926c21cc3ff63757fe7
Author: LakshanSanjeewa <lakshan.s@boswingroup.com>
AuthorDate: 2026-07-20T01:58:49+05:30
Committer: LakshanSanjeewa <lakshan.s@boswingroup.com>
CommitDate: 2026-07-20T01:58:49+05:30
Parents: b591d96c5330f90ce90e2e3c1bf8142474b791f9
Refs: 
Subject: slice1: client role + frontend role gating



 12 files changed, 243 insertions(+), 46 deletions(-)

commit b591d96c5330f90ce90e2e3c1bf8142474b791f9
Author: LakshanSanjeewa <lakshan.s@boswingroup.com>
AuthorDate: 2026-07-20T00:57:38+05:30
Committer: LakshanSanjeewa <lakshan.s@boswingroup.com>
CommitDate: 2026-07-20T00:57:38+05:30
Parents: 17a4f9b08541a7b4009b6d008d912f7eaa1669a7
Refs: refs/remotes/origin/feat/experiment-readiness, refs/heads/feat/experiment-readiness
Subject: add evaluation dataset generator + 120 labelled cases



 6 files changed, 714 insertions(+)
commit 17a4f9b08541a7b4009b6d008d912f7eaa1669a7
Author: LakshanSanjeewa <lakshan.s@boswingroup.com>
AuthorDate: 2026-07-20T00:48:27+05:30
Committer: LakshanSanjeewa <lakshan.s@boswingroup.com>
CommitDate: 2026-07-20T00:48:27+05:30
Parents: 43a384c704e74f6c0a1ba5d4d22d36656804e83e
Refs: 
Subject: add Baseline B experiment mode



 9 files changed, 244 insertions(+), 13 deletions(-)
commit 43a384c704e74f6c0a1ba5d4d22d36656804e83e
Author: LakshanSanjeewa <lakshan.s@boswingroup.com>
AuthorDate: 2026-07-20T00:41:20+05:30
Committer: LakshanSanjeewa <lakshan.s@boswingroup.com>
CommitDate: 2026-07-20T00:41:20+05:30
Parents: bf78689905e3262ac3183d93200e7578ce365f02
Refs: 
Subject: verify G1/G2



 155 files changed, 5491 insertions(+), 3163 deletions(-)
commit bf78689905e3262ac3183d93200e7578ce365f02
Author: lakshan sanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-12T20:29:39+05:30
Committer: GitHub <noreply@github.com>
CommitDate: 2026-05-12T20:29:39+05:30
Parents: 34efe141ae384274e08931c6b39de43272e6d66a
Refs: refs/heads/feat/g1-g2-gate-invariant
Subject: Update Readme.md



 1 file changed, 6 insertions(+)
commit 34efe141ae384274e08931c6b39de43272e6d66a
Author: lakshan sanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-12T20:28:29+05:30
Committer: GitHub <noreply@github.com>
CommitDate: 2026-05-12T20:28:29+05:30
Parents: 1d84e6a3d3d91ce0149e1075aa9b1756c30193e7
Refs: 
Subject: Create Readme.md



 1 file changed, 1 insertion(+)
commit e6287b12194734138e0f6891442cab168da9f0bf
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-12T20:24:33+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-05-12T20:24:33+05:30
Parents: 1d84e6a3d3d91ce0149e1075aa9b1756c30193e7 6da02b8db1b2166f8a8ffd8575ee3d32b74cf983
Refs: refs/stash
Subject: On main: !!GitHub_Desktop<main>


commit 6da02b8db1b2166f8a8ffd8575ee3d32b74cf983
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-12T20:24:33+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-05-12T20:24:33+05:30
Parents: 1d84e6a3d3d91ce0149e1075aa9b1756c30193e7
Refs: 
Subject: index on main: 1d84e6a Create README.md



 24 files changed, 218789 insertions(+)
commit 1d84e6a3d3d91ce0149e1075aa9b1756c30193e7
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-12T20:23:05+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-05-12T20:23:05+05:30
Parents: a8ec62a7c5476e1a0ca77c2e444bc3a57cb10d38
Refs: refs/remotes/origin/intergration, refs/heads/intergration
Subject: Create README.md



 1 file changed, 351 insertions(+)
commit a8ec62a7c5476e1a0ca77c2e444bc3a57cb10d38
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-10T23:29:30+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-05-10T23:29:30+05:30
Parents: db7a7f1ea8730f2a4af3230ee89657073ee1db17
Refs: 
Subject: Add comprehensive backend documentation

Add a full set of Markdown documentation files mirroring the backend project structure. Includes a CODEBASE_INDEX and detailed READMEs for cmd/server, configs, dataset, internal packages (api, handlers, middlewares, routes, config), core components (orchestrator, registry, runner, synthesizer, semanticsearch, validator, healing), models, repository, tools (and impl), pkg utilities, the semantic_search_service, and the tests directory (unit, integration, fixtures, mocks). These docs provide architecture overviews, component responsibilities, interactions, and testing guidance to help onboard developers and support future implementation work. (Docs appear to be generated by the Gemini CLI.)


 27 files changed, 816 insertions(+)
commit db7a7f1ea8730f2a4af3230ee89657073ee1db17
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-10T17:24:58+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-05-10T17:24:58+05:30
Parents: 3607e32ba104c8c3cb0b29d7f76b65ba429778fb
Refs: 
Subject: Add datafeed pages and improve bridge/finetune UI

Introduce PipelineConfigPage and VectorMetricsPage and register their routes in App.jsx; VectorMetrics uses Recharts to display storage and latency charts. Revamp DatafeedPage to show Vector DB status, sync controls and pipeline configuration summaries. Enhance FinetunePage into an ERP Model Integration view with sync/model settings and a chat-like query playground. Expand McpBridgePage with a tool registry (add/register tools), bridge configurations, and live terminal logs. Minor UI/layout tweak in WorkflowBuilderCanvas and update navigation labels/submenus for datafeed and finetune sections.


 8 files changed, 703 insertions(+), 167 deletions(-)
commit 3607e32ba104c8c3cb0b29d7f76b65ba429778fb
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-10T16:39:05+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-05-10T16:39:05+05:30
Parents: 67544d298a45f967b1d57b8e7b9c37189ac67c8c
Refs: 
Subject: Add test-report target and generated artifacts

Add a Makefile target `test-report` in backend to install `go-test-report` and generate an HTML test report (`go test -json ./... | go-test-report`). Include the generated HTML report (`backend/test_report.html`), a recorded test output (`test results.md`), and a new role-based natural language testing guide (`docs/ROLE_NATURAL_LANGUAGE_TEST_GUIDE.md`) to help validate RBAC and workflow-generation prompts. These additions provide an easy way to produce a human-readable test report and ship test/run documentation for developer use.


 4 files changed, 1008 insertions(+)
commit 67544d298a45f967b1d57b8e7b9c37189ac67c8c
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-10T14:23:36+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-05-10T14:23:36+05:30
Parents: f995c1176ac2a7c60fd5672d5f7c1298ed7dd7d5
Refs: 
Subject: adding approval like things



 12 files changed, 585 insertions(+), 22 deletions(-)
commit f995c1176ac2a7c60fd5672d5f7c1298ed7dd7d5
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-10T11:43:11+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-05-10T11:43:11+05:30
Parents: 43714e55f3886d9360564d706c264e2515d1fb5b
Refs: 
Subject: Add auth flow, token refresh & chat UI updates

Introduce a full auth flow and enhance chat UI/UX. Adds AuthProvider and context (login/register/logout, error/loading states), App-level auth routing (login/register/forgot), and an AuthGuard component. Enhance axios client: increased timeout, attach bearer token, and implement 401 handling with silent token refresh and request queue; emits auth:expired on refresh failure. Add a comprehensive ChatArtifactPanel component for validation/tool/rule/candidate summaries and integrate artifact summaries into ChatMessage. Improve chat features: ChatWindow auto-scroll/typing indicator, model/mode selectors in ChatToolbar, session list UX (create/rename/delete) and skeleton loading in ChatHistory, and richer ChatSessionItem interactions. Add Topbar user menu, small style/layout fixes, and related helper hooks/service uses.


 24 files changed, 1654 insertions(+), 172 deletions(-)
commit 43714e55f3886d9360564d706c264e2515d1fb5b
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-10T10:08:19+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-05-10T10:08:19+05:30
Parents: a05b51a82059ba7708c009b9987f15d1986430cc
Refs: refs/remotes/origin/validator_checking, refs/heads/validator_checking
Subject: aadding the files to cha chat



 38 files changed, 3317 insertions(+), 106 deletions(-)
commit a05b51a82059ba7708c009b9987f15d1986430cc
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-09T20:07:10+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-05-09T20:07:10+05:30
Parents: 0725617673796d37850b30404e541e0ed428c049
Refs: 
Subject: Update chat_orchestrator.go



 1 file changed, 114 insertions(+), 4 deletions(-)
commit 0725617673796d37850b30404e541e0ed428c049
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-09T18:12:13+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-05-09T18:12:13+05:30
Parents: 096b4c6ad1ebd85c3a4d57fcfc08aa7cc89758ad
Refs: 
Subject: optimizing the workflow and the data set



 77 files changed, 759005 insertions(+), 65 deletions(-)
commit 096b4c6ad1ebd85c3a4d57fcfc08aa7cc89758ad
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-09T09:36:11+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-05-09T09:36:11+05:30
Parents: 69e58375061cface1f3c79b686c8b29a0a8db315
Refs: 
Subject: updating the ui for componet wise



 6 files changed, 294 insertions(+)
commit 69e58375061cface1f3c79b686c8b29a0a8db315
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-09T04:13:30+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-05-09T04:13:30+05:30
Parents: 24833d02a93a893f16eb7e69b31eefb16fa77b89
Refs: 
Subject: Trigger sync workflow


commit 24833d02a93a893f16eb7e69b31eefb16fa77b89
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-09T03:56:05+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-05-09T03:56:05+05:30
Parents: 66bd091b9c8ec783912eff507ac8d4d7e93c0c95
Refs: 
Subject: Add auto sync workflow to main repository



 1 file changed, 39 insertions(+)
commit 66bd091b9c8ec783912eff507ac8d4d7e93c0c95
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-08T10:00:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-05-08T10:00:00+05:30
Parents: 35d8821f8571f35917e21a51381c5315e4ee252b
Refs: refs/remotes/origin/workflow_generation, refs/heads/workflow_generation
Subject: prepare repository for GitHub push



 107 files changed, 286084 insertions(+), 112 deletions(-)

commit 35d8821f8571f35917e21a51381c5315e4ee252b
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-06T10:00:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-05-06T10:00:00+05:30
Parents: 00a4c9c54fe80716e181bde830664a5269ef6392
Refs: 
Subject: add semantic validation dataset



 122 files changed, 1882 insertions(+), 30 deletions(-)
commit 00a4c9c54fe80716e181bde830664a5269ef6392
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-04T10:00:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-05-04T10:00:00+05:30
Parents: e54cd91680ec14d104115555d9aab8f36a4959c7
Refs: 
Subject: add API documentation



 33 files changed, 218 insertions(+), 17 deletions(-)
commit e54cd91680ec14d104115555d9aab8f36a4959c7
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-05-02T10:00:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-05-02T10:00:00+05:30
Parents: aabec4e773e8cd9e4cb16b88da8d36b002a94d7d
Refs: 
Subject: add tests



 44 files changed, 713 insertions(+), 27 deletions(-)
commit aabec4e773e8cd9e4cb16b88da8d36b002a94d7d
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-04-30T10:00:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-04-30T10:00:00+05:30
Parents: 2577df9f1990cad9c601498a848424292e6f95f4
Refs: 
Subject: add settings profile integrations and notifications



 43 files changed, 297 insertions(+), 16 deletions(-)
commit 2577df9f1990cad9c601498a848424292e6f95f4
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-04-27T10:00:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-04-27T10:00:00+05:30
Parents: dbfd62b8500076e17ac52bab636f2b2731f4e2c9
Refs: 
Subject: add frontend execution monitoring



 34 files changed, 326 insertions(+), 18 deletions(-)
commit dbfd62b8500076e17ac52bab636f2b2731f4e2c9
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-04-24T10:00:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-04-24T10:00:00+05:30
Parents: 08c659f19a56034d95131304d1ec2afc421320d0
Refs: 
Subject: add frontend chat and synthesis UI



 61 files changed, 1601 insertions(+), 43 deletions(-)
commit 08c659f19a56034d95131304d1ec2afc421320d0
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-04-21T10:00:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-04-21T10:00:00+05:30
Parents: 7e767e2970e423f52054fb415ae8b37a131e53dc
Refs: 
Subject: add frontend workflow builder



 68 files changed, 554 insertions(+), 25 deletions(-)
commit 7e767e2970e423f52054fb415ae8b37a131e53dc
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-04-18T10:00:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-04-18T10:00:00+05:30
Parents: 610b98747fbd713ed23ef3c76da1779bc71aa916
Refs: 
Subject: add frontend dashboard and analytics



 65 files changed, 394 insertions(+), 40 deletions(-)
commit 610b98747fbd713ed23ef3c76da1779bc71aa916
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-04-15T10:00:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-04-15T10:00:00+05:30
Parents: a9c206485e1cffdbb2a3a85f99c26cd784f92ad1
Refs: 
Subject: add frontend auth and users



 96 files changed, 719 insertions(+), 56 deletions(-)
commit a9c206485e1cffdbb2a3a85f99c26cd784f92ad1
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-04-13T10:00:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-04-13T10:00:00+05:30
Parents: 3963fdff20a438a04eb81ac250ccfdd4e9c0de5e
Refs: 
Subject: add frontend shared UI components



 110 files changed, 1187 insertions(+), 60 deletions(-)
commit 3963fdff20a438a04eb81ac250ccfdd4e9c0de5e
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-04-11T10:00:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-04-11T10:00:00+05:30
Parents: 10c6d4900868e6220f9df38c0358de543a4ce87e
Refs: 
Subject: add frontend app shell and routing



 59 files changed, 270 insertions(+), 5 deletions(-)
commit 10c6d4900868e6220f9df38c0358de543a4ce87e
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-04-09T10:00:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-04-09T10:00:00+05:30
Parents: 005e9c146a6fa449dfdcf06ab46cf442497272cc
Refs: 
Subject: add backend MCP tools integration



 9 files changed, 364 insertions(+), 4 deletions(-)
commit 005e9c146a6fa449dfdcf06ab46cf442497272cc
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-04-07T10:00:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-04-07T10:00:00+05:30
Parents: dcdae8576bb3ba805cc446ddd2949029f998af3e
Refs: 
Subject: add backend synthesis and validation



 9 files changed, 292 insertions(+), 5 deletions(-)
commit dcdae8576bb3ba805cc446ddd2949029f998af3e
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-04-05T10:00:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-04-05T10:00:00+05:30
Parents: e5616d2aec329e77b3d8cfe798e81c9114465849
Refs: 
Subject: add backend workflow runner



 18 files changed, 1669 insertions(+), 13 deletions(-)
commit e5616d2aec329e77b3d8cfe798e81c9114465849
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-04-03T10:00:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-04-03T10:00:00+05:30
Parents: e7edcec4f6fd66266955b048331ab49912c85ee8
Refs: 
Subject: add backend API routes and handlers



 21 files changed, 665 insertions(+), 8 deletions(-)
commit e7edcec4f6fd66266955b048331ab49912c85ee8
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-04-01T10:00:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-04-01T10:00:00+05:30
Parents: b406e56af46dfb45aec74603a216c5a72acb97fa
Refs: 
Subject: add backend data models and repositories



 24 files changed, 9494 insertions(+), 19 deletions(-)
commit b406e56af46dfb45aec74603a216c5a72acb97fa
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-03-29T10:00:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-03-29T10:00:00+05:30
Parents: 6c35da7ac07e0f97ff27764c0255ade457360f9a
Refs: 
Subject: add frontend project scaffold



 28 files changed, 449 insertions(+), 12 deletions(-)
commit 6c35da7ac07e0f97ff27764c0255ade457360f9a
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-03-27T10:00:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-03-27T10:00:00+05:30
Parents: 5ee79bcc2153d27e5d79373c95f64a83e78b076b
Refs: 
Subject: add backend project scaffold



 13 files changed, 14 insertions(+), 1 deletion(-)
commit 5ee79bcc2153d27e5d79373c95f64a83e78b076b
Author: LakshanSanjeewa <lk.snjw@gmail.com>
AuthorDate: 2026-03-25T09:30:00+05:30
Committer: LakshanSanjeewa <lk.snjw@gmail.com>
CommitDate: 2026-03-25T09:30:00+05:30
Parents: 
Refs: 
Subject: initialize project repository settings



 2 files changed, 2 insertions(+)
```

