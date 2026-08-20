# Frontend ↔ backend API pairing

Scope: every direct HTTP call under `frontend/src/services`, plus the Axios refresh request and the application-shell health request. The configured Axios base URL supplies the `/api` prefix, so paths below are shown as the frontend writes them.

| # | Frontend call | Method + path | Backend handler | Both found? | Evidence |
|---:|---|---|---|---|---|
| 1 | `analyticsService.load` summary | `GET /analytics/summary` | `AnalyticsSummary` | Yes | `frontend/src/services/analytics.service.js:8`; `backend/internal/api/routes/routes.go:138` |
| 2 | `analyticsService.load` performance | `GET /analytics/performance` | `AnalyticsPerformance` | Yes | `frontend/src/services/analytics.service.js:9`; `backend/internal/api/routes/routes.go:139` |
| 3 | `analyticsService.load` usage | `GET /analytics/usage` | `AnalyticsUsage` | Yes | `frontend/src/services/analytics.service.js:10`; `backend/internal/api/routes/routes.go:140` |
| 4 | `analyticsService.load` healing | `GET /analytics/self-healing` | `AnalyticsSelfHealing` | Yes | `frontend/src/services/analytics.service.js:11`; `backend/internal/api/routes/routes.go:141` |
| 5 | `analyticsService.load` latency | `GET /analytics/latency` | `AnalyticsLatency` | Yes | `frontend/src/services/analytics.service.js:12`; `backend/internal/api/routes/routes.go:142` |
| 6 | `analyticsService.load` F1 | `GET /analytics/f1-score` | `AnalyticsF1Score` | Yes | `frontend/src/services/analytics.service.js:13`; `backend/internal/api/routes/routes.go:143` |
| 7 | `analyticsService.load` heatmap | `GET /analytics/activity-heatmap` | `AnalyticsActivityHeatmap` | Yes | `frontend/src/services/analytics.service.js:14`; `backend/internal/api/routes/routes.go:144` |
| 8 | `analyticsService.load` costs | `GET /analytics/cost-trends` | `AnalyticsCostTrends` | Yes | `frontend/src/services/analytics.service.js:15`; `backend/internal/api/routes/routes.go:145` |
| 9 | `auditService.list` | `GET /audit` | `ListAudit` | Yes | `frontend/src/services/audit.service.js:6`; `backend/internal/api/routes/routes.go:166` |
| 10 | `authService.login` | `POST /auth/login` | `Login` | Yes | `frontend/src/services/auth.service.js:18`; `backend/internal/api/routes/routes.go:21` |
| 11 | `authService.register` | `POST /auth/register` | `Register` | Yes | `frontend/src/services/auth.service.js:23`; `backend/internal/api/routes/routes.go:22` |
| 12 | `authService.me` | `GET /auth/me` | `Me` | Yes | `frontend/src/services/auth.service.js:28`; `backend/internal/api/routes/routes.go:47` |
| 13 | `authService.refresh` | `POST /auth/refresh` | `Refresh` | Yes | `frontend/src/services/auth.service.js:34`; `backend/internal/api/routes/routes.go:23` |
| 14 | `authService.forgotPassword` | `POST /auth/forgot-password` | `ForgotPassword` | Yes | `frontend/src/services/auth.service.js:39`; `backend/internal/api/routes/routes.go:24` |
| 15 | `authService.resetPassword` | `POST /auth/reset-password` | `ResetPassword` | Yes | `frontend/src/services/auth.service.js:44`; `backend/internal/api/routes/routes.go:25` |
| 16 | `authService.verifyEmail` | `POST /auth/verify-email` | `VerifyEmail` | Yes | `frontend/src/services/auth.service.js:49`; `backend/internal/api/routes/routes.go:26` |
| 17 | `authService.logout` | `POST /auth/logout` | `Logout` | Yes | `frontend/src/services/auth.service.js:55`; `backend/internal/api/routes/routes.go:46` |
| 18 | `authService.oauthAuthorize` | `GET /auth/oauth/:provider/authorize` | `OAuthAuthorize` | Yes | `frontend/src/services/auth.service.js:62`; `backend/internal/api/routes/routes.go:27` |
| 19 | `authService.twoFactorVerify` | `POST /auth/2fa/verify` | `TwoFactorVerify` | Yes | `frontend/src/services/auth.service.js:67`; `backend/internal/api/routes/routes.go:48` |
| 20 | Axios `refreshSession` | `POST /auth/refresh` | `Refresh` | Yes | `frontend/src/config/axios.js:78-88`; `backend/internal/api/routes/routes.go:23` |
| 21 | `catalogService.tools` | `GET /tools/catalog` | `ToolsCatalog` | Yes | `frontend/src/services/catalog.service.js:9`; `backend/internal/api/routes/routes.go:100` |
| 22 | `chatService.listSessions` | `GET /chat/sessions` | `ListChatSessions` | Yes | `frontend/src/services/chat.service.js:5`; `backend/internal/api/routes/routes.go:123` |
| 23 | `chatService.createSession` | `POST /chat/sessions` | `CreateChatSession` | Yes | `frontend/src/services/chat.service.js:10`; `backend/internal/api/routes/routes.go:124` |
| 24 | `chatService.getSession` | `GET /chat/sessions/:id` | `GetChatSession` | Yes | `frontend/src/services/chat.service.js:15`; `backend/internal/api/routes/routes.go:125` |
| 25 | `chatService.updateSession` | `PATCH /chat/sessions/:id` | `UpdateChatSession` | Yes | `frontend/src/services/chat.service.js:20`; `backend/internal/api/routes/routes.go:126` |
| 26 | `chatService.deleteSession` | `DELETE /chat/sessions/:id` | `DeleteChatSession` | Yes | `frontend/src/services/chat.service.js:25`; `backend/internal/api/routes/routes.go:127` |
| 27 | `chatService.sendMessage` | `POST /chat/sessions/:id/messages` | `SendChatMessage` | Yes | `frontend/src/services/chat.service.js:29-34`; `backend/internal/api/routes/routes.go:128` |
| 28 | `companyService.get` | `GET /company` | `GetCompany` | Yes | `frontend/src/services/company.service.js:6`; `backend/internal/api/routes/routes.go:52` |
| 29 | `companyService.update` | `PUT /company` | `UpdateCompany` | Yes | `frontend/src/services/company.service.js:9`; `backend/internal/api/routes/routes.go:53` |
| 30 | `companyService.createDepartment` | `POST /company/departments` | `CreateCompanyDepartment` | Yes | `frontend/src/services/company.service.js:12`; `backend/internal/api/routes/routes.go:55` |
| 31 | `companyService.updateDepartment` | `PUT /company/departments/:id` | `UpdateCompanyDepartment` | Yes | `frontend/src/services/company.service.js:15`; `backend/internal/api/routes/routes.go:56` |
| 32 | `companyService.deleteDepartment` | `DELETE /company/departments/:id` | `DeleteCompanyDepartment` | Yes | `frontend/src/services/company.service.js:18`; `backend/internal/api/routes/routes.go:57` |
| 33 | `companyService.createCostCentre` | `POST /company/cost-centres` | `CreateCompanyCostCentre` | Yes | `frontend/src/services/company.service.js:21`; `backend/internal/api/routes/routes.go:59` |
| 34 | `companyService.updateCostCentre` | `PUT /company/cost-centres/:id` | `UpdateCompanyCostCentre` | Yes | `frontend/src/services/company.service.js:24`; `backend/internal/api/routes/routes.go:60` |
| 35 | `companyService.deleteCostCentre` | `DELETE /company/cost-centres/:id` | `DeleteCompanyCostCentre` | Yes | `frontend/src/services/company.service.js:27`; `backend/internal/api/routes/routes.go:61` |
| 36 | `companyService.createApprovalTier` | `POST /company/approval-tiers` | `CreateCompanyApprovalTier` | Yes | `frontend/src/services/company.service.js:30`; `backend/internal/api/routes/routes.go:63` |
| 37 | `companyService.updateApprovalTier` | `PUT /company/approval-tiers/:id` | `UpdateCompanyApprovalTier` | Yes | `frontend/src/services/company.service.js:33`; `backend/internal/api/routes/routes.go:64` |
| 38 | `companyService.deleteApprovalTier` | `DELETE /company/approval-tiers/:id` | `DeleteCompanyApprovalTier` | Yes | `frontend/src/services/company.service.js:36`; `backend/internal/api/routes/routes.go:65` |
| 39 | `dashboardService.load` summary | `GET /dashboard/summary` | `DashboardSummary` | Yes | `frontend/src/services/dashboard.service.js:8`; `backend/internal/api/routes/routes.go:67` |
| 40 | `dashboardService.load` activity | `GET /dashboard/activity` | `DashboardActivity` | Yes | `frontend/src/services/dashboard.service.js:9`; `backend/internal/api/routes/routes.go:68` |
| 41 | `dashboardService.load` health | `GET /dashboard/health` | `DashboardHealth` | Yes | `frontend/src/services/dashboard.service.js:10`; `backend/internal/api/routes/routes.go:69` |
| 42 | `dashboardService.load` workflows | `GET /dashboard/recent-workflows` | `RecentWorkflows` | Yes | `frontend/src/services/dashboard.service.js:11`; `backend/internal/api/routes/routes.go:70` |
| 43 | `executionService.list` | `GET /executions` | `ListExecutions` | Yes | `frontend/src/services/execution.service.js:17`; `backend/internal/api/routes/routes.go:130` |
| 44 | `executionService.get` | `GET /executions/:id` | `GetExecution` | Yes | `frontend/src/services/execution.service.js:21`; `backend/internal/api/routes/routes.go:131` |
| 45 | `executionService.getLogs` | `GET /executions/:id/logs` | `ExecutionLogs` | Yes | `frontend/src/services/execution.service.js:24`; `backend/internal/api/routes/routes.go:132` |
| 46 | `executionService.getTimeline` | `GET /executions/:id/timeline` | `ExecutionTimeline` | Yes | `frontend/src/services/execution.service.js:27`; `backend/internal/api/routes/routes.go:133` |
| 47 | `executionService.getHealingReport` | `GET /executions/:id/healing-report` | `ExecutionHealingReport` | Yes | `frontend/src/services/execution.service.js:30`; `backend/internal/api/routes/routes.go:134` |
| 48 | `executionService.run` | `POST /workflows/:id/run` | `RunWorkflow` | Yes | `frontend/src/services/execution.service.js:32-35`; `backend/internal/api/routes/routes.go:85` |
| 49 | `executionService.retry` | `POST /executions/:id/retry` | `RetryExecution` | Yes | `frontend/src/services/execution.service.js:38`; `backend/internal/api/routes/routes.go:136` |
| 50 | `integrationService.list` | `GET /integrations` | `ListIntegrations` | Yes | `frontend/src/services/integration.service.js:6`; `backend/internal/api/routes/routes.go:197` |
| 51 | `integrationService.create` | `POST /integrations` | `CreateIntegration` | Yes | `frontend/src/services/integration.service.js:9`; `backend/internal/api/routes/routes.go:198` |
| 52 | `integrationService.test` | `POST /integrations/:id/test` | `TestIntegration` | Yes | `frontend/src/services/integration.service.js:12`; `backend/internal/api/routes/routes.go:202` |
| 53 | `integrationService.connect` | `POST /integrations/:id/connect` | `ConnectIntegration` | Yes | `frontend/src/services/integration.service.js:15`; `backend/internal/api/routes/routes.go:203` |
| 54 | `integrationService.disconnect` | `POST /integrations/:id/disconnect` | `DisconnectIntegration` | Yes | `frontend/src/services/integration.service.js:18`; `backend/internal/api/routes/routes.go:204` |
| 55 | `notificationService.list` | `GET /notifications` | `ListNotifications` | Yes | `frontend/src/services/notification.service.js:6`; `backend/internal/api/routes/routes.go:206` |
| 56 | `notificationService.markRead` | `PATCH /notifications/:id/read` | `MarkNotificationRead` | Yes | `frontend/src/services/notification.service.js:9`; `backend/internal/api/routes/routes.go:208` |
| 57 | `notificationService.markAllRead` | `PATCH /notifications/read-all` | `MarkAllNotificationsRead` | Yes | `frontend/src/services/notification.service.js:12`; `backend/internal/api/routes/routes.go:207` |
| 58 | `profileService.get` | `GET /profile` | `GetProfile` | Yes | `frontend/src/services/profile.service.js:6`; `backend/internal/api/routes/routes.go:169` |
| 59 | `profileService.update` | `PATCH /profile` | `UpdateProfile` | Yes | `frontend/src/services/profile.service.js:9`; `backend/internal/api/routes/routes.go:170` |
| 60 | `registryService.load` tools | `GET /registry/tools` | `AdminToolsRegistry` | Yes | `frontend/src/services/registry.service.js:7`; `backend/internal/api/routes/routes.go:107` |
| 61 | `registryService.load` rules | `GET /registry/rules` | `AdminRulesRegistry` | Yes | `frontend/src/services/registry.service.js:8`; `backend/internal/api/routes/routes.go:115` |
| 62 | `registryService.status` | `GET /registry/status` | `RegistryStatus` | Yes | `frontend/src/services/registry.service.js:13`; `backend/internal/api/routes/routes.go:108` |
| 63 | `registryService.context` | `GET /registry/context` | `GetRegistryContext` | Yes | `frontend/src/services/registry.service.js:16`; `backend/internal/api/routes/routes.go:109` |
| 64 | `registryService.regenerateContext` | `POST /registry/context/regenerate` | `RegenerateRegistryContext` | Yes | `frontend/src/services/registry.service.js:19`; `backend/internal/api/routes/routes.go:110` |
| 65 | `registryService.contextHistory` | `GET /registry/context/history` | `RegistryContextHistory` | Yes | `frontend/src/services/registry.service.js:22`; `backend/internal/api/routes/routes.go:111` |
| 66 | `registryService.create` | `POST /registry/{tools\|rules}` | `CreateRegistryTool` / `CreateRegistryRule` | Yes for supported `kind` values | `frontend/src/services/registry.service.js:25`; `backend/internal/api/routes/routes.go:113,117` |
| 67 | `registryService.update` | `PUT /registry/{tools\|rules}/:id` | `UpdateRegistryTool` / `UpdateRegistryRule` | Yes for supported `kind` values | `frontend/src/services/registry.service.js:28`; `backend/internal/api/routes/routes.go:114,118` |
| 68 | `registryService.bulkImport` | `POST /registry/{tools\|rules}/import` | `ImportRegistryTools` / `ImportRegistryRules` | Yes for supported `kind` values | `frontend/src/services/registry.service.js:31`; `backend/internal/api/routes/routes.go:112,116` |
| 69 | `registryService.analyseImport` | `POST /import/analyse` | `AnalyseRegistryImport` | Yes | `frontend/src/services/registry.service.js:34-39`; `backend/internal/api/routes/routes.go:119` |
| 70 | `registryService.commitImport` | `POST /import/commit` | `CommitRegistryImport` | Yes | `frontend/src/services/registry.service.js:42`; `backend/internal/api/routes/routes.go:120` |
| 71 | `registryService.importHistory` | `GET /import/history` | `RegistryImportHistory` | Yes | `frontend/src/services/registry.service.js:45`; `backend/internal/api/routes/routes.go:121` |
| 72 | `semanticService.health` | `GET /semantic-index/health` | `SemanticServiceHealth` | Yes | `frontend/src/services/semantic.service.js:6`; `backend/internal/api/routes/routes.go:103` |
| 73 | `semanticService.metadata` | `GET /semantic-index/metadata` | `SemanticIndexMetadata` | Yes | `frontend/src/services/semantic.service.js:9`; `backend/internal/api/routes/routes.go:104` |
| 74 | `semanticService.rebuild` | `POST /semantic-index/rebuild` | `RebuildSemanticIndex` | Yes | `frontend/src/services/semantic.service.js:16`; `backend/internal/api/routes/routes.go:105` |
| 75 | `settingsService.load` settings | `GET /settings` | `GetSettings` | Yes | `frontend/src/services/settings.service.js:7`; `backend/internal/api/routes/routes.go:178` |
| 76 | `settingsService.load` integrations | `GET /integrations` | `ListIntegrations` | Yes | `frontend/src/services/settings.service.js:8`; `backend/internal/api/routes/routes.go:197` |
| 77 | `settingsService.load` webhooks | `GET /settings/webhooks` | `ListWebhooks` | Yes | `frontend/src/services/settings.service.js:9`; `backend/internal/api/routes/routes.go:191` |
| 78 | `settingsService.load` API keys | `GET /profile/api-keys` | `ListAPIKeys` | Yes | `frontend/src/services/settings.service.js:10`; `backend/internal/api/routes/routes.go:174` |
| 79 | `settingsService.update` | `PATCH /settings` | `PatchSettings` | Yes | `frontend/src/services/settings.service.js:20`; `backend/internal/api/routes/routes.go:179` |
| 80 | `settingsService.createWebhook` | `POST /settings/webhooks` | `CreateWebhook` | Yes | `frontend/src/services/settings.service.js:23`; `backend/internal/api/routes/routes.go:192` |
| 81 | `settingsService.providers` | `GET /providers` | `ListProviders` | Yes | `frontend/src/services/settings.service.js:26`; `backend/internal/api/routes/routes.go:184` |
| 82 | `settingsService.createProvider` | `POST /providers` | `CreateProvider` | Yes | `frontend/src/services/settings.service.js:29`; `backend/internal/api/routes/routes.go:185` |
| 83 | `settingsService.updateProvider` | `PUT /providers/:id` | `UpdateProvider` | Yes | `frontend/src/services/settings.service.js:32`; `backend/internal/api/routes/routes.go:186` |
| 84 | `settingsService.activateProvider` | `POST /providers/:id/activate` | `ActivateProvider` | Yes | `frontend/src/services/settings.service.js:35`; `backend/internal/api/routes/routes.go:187` |
| 85 | `settingsService.testProvider` | `POST /providers/:id/test` | `TestProvider` | Yes | `frontend/src/services/settings.service.js:38`; `backend/internal/api/routes/routes.go:188` |
| 86 | `synthesisService.synthesize` | `POST /synthesis` | `Synthesize` | Yes | `frontend/src/services/synthesis.service.js:6`; `backend/internal/api/routes/routes.go:96` |
| 87 | `synthesisService.semanticSearch` | `POST /semantic-search` | `SemanticSearch` | Yes | `frontend/src/services/synthesis.service.js:9`; `backend/internal/api/routes/routes.go:102` |
| 88 | `uploadService.upload` | `POST /upload` | `Upload` | Yes | `frontend/src/services/upload.service.js:5-8`; `backend/internal/api/routes/routes.go:210` |
| 89 | `userService.loadAdministration` users | `GET /users` | `ListUsers` | Yes | `frontend/src/services/user.service.js:9`; `backend/internal/api/routes/routes.go:147` |
| 90 | `userService.loadAdministration` roles | `GET /roles` | `ListRoles` | Yes | `frontend/src/services/user.service.js:10`; `backend/internal/api/routes/routes.go:157` |
| 91 | `userService.loadAdministration` permissions | `GET /permissions` | `ListPermissions` | Yes | `frontend/src/services/user.service.js:11`; `backend/internal/api/routes/routes.go:163` |
| 92 | `userService.loadAdministration` matrix | `GET /permissions/matrix` | `PermissionMatrix` | Yes | `frontend/src/services/user.service.js:12`; `backend/internal/api/routes/routes.go:164` |
| 93 | `userService.loadAdministration` departments | `GET /company/departments` | `ListCompanyDepartments` | Yes | `frontend/src/services/user.service.js:13`; `backend/internal/api/routes/routes.go:54` |
| 94 | `userService.loadAudit` | `GET /audit` | `ListAudit` | Yes | `frontend/src/services/user.service.js:24`; `backend/internal/api/routes/routes.go:166` |
| 95 | `userService.create` | `POST /users` | `CreateUser` | Yes | `frontend/src/services/user.service.js:27`; `backend/internal/api/routes/routes.go:148` |
| 96 | `userService.updateRole` | `PUT /users/:id/role` | `UpdateUserRole` | Yes | `frontend/src/services/user.service.js:30`; `backend/internal/api/routes/routes.go:152` |
| 97 | `userService.updateStatus` | `PUT /users/:id/status` | `UpdateUserStatus` | Yes | `frontend/src/services/user.service.js:33`; `backend/internal/api/routes/routes.go:153` |
| 98 | `userService.updateDepartment` | `PATCH /users/:id` | `UpdateUser` | Yes | `frontend/src/services/user.service.js:36`; `backend/internal/api/routes/routes.go:151` |
| 99 | `userService.updateRoleDefinition` | `PUT /roles/:id` | `UpdateRole` | Yes | `frontend/src/services/user.service.js:39`; `backend/internal/api/routes/routes.go:160` |
| 100 | `userService.createRole` | `POST /roles` | `CreateRole` | Yes | `frontend/src/services/user.service.js:42`; `backend/internal/api/routes/routes.go:158` |
| 101 | `userService.deleteRole` | `DELETE /roles/:id` | `DeleteRole` | Yes | `frontend/src/services/user.service.js:45`; `backend/internal/api/routes/routes.go:162` |
| 102 | `userService.assignable` | `GET /workflows/assignable-users` | `ListAssignableWorkflowUsers` | Yes | `frontend/src/services/user.service.js:48`; `backend/internal/api/routes/routes.go:77` |
| 103 | `workflowService.list` | `GET /workflows` | `ListWorkflows` | Yes | `frontend/src/services/workflow.service.js:23`; `backend/internal/api/routes/routes.go:75` |
| 104 | `workflowService.getById` | `GET /workflows/:id` | `GetWorkflow` | Yes | `frontend/src/services/workflow.service.js:27`; `backend/internal/api/routes/routes.go:78` |
| 105 | `workflowService.create` | `POST /workflows` | `CreateWorkflow` | Yes | `frontend/src/services/workflow.service.js:31`; `backend/internal/api/routes/routes.go:76` |
| 106 | `workflowService.update` | `PATCH /workflows/:id` | `UpdateWorkflow` | Yes | `frontend/src/services/workflow.service.js:35`; `backend/internal/api/routes/routes.go:79` |
| 107 | `workflowService.remove` | `DELETE /workflows/:id` | `DeleteWorkflow` | Yes | `frontend/src/services/workflow.service.js:39`; `backend/internal/api/routes/routes.go:80` |
| 108 | `workflowService.listTemplates` | `GET /workflows/templates` | `ListTemplates` | Yes | `frontend/src/services/workflow.service.js:42`; `backend/internal/api/routes/routes.go:72` |
| 109 | `workflowService.useTemplate` | `POST /workflows/templates/:id/use` | `UseTemplate` | Yes | `frontend/src/services/workflow.service.js:45`; `backend/internal/api/routes/routes.go:74` |
| 110 | `workflowService.getCanvas` | `GET /workflows/:id/canvas` | `GetWorkflowCanvas` | Yes | `frontend/src/services/workflow.service.js:48`; `backend/internal/api/routes/routes.go:90` |
| 111 | `workflowService.getYAML` | `GET /workflows/:id/yaml` | `GetWorkflowYAML` | Yes | `frontend/src/services/workflow.service.js:51`; `backend/internal/api/routes/routes.go:88` |
| 112 | `workflowService.saveYAML` | `PUT /workflows/:id/yaml` | `PutWorkflowYAML` | Yes | `frontend/src/services/workflow.service.js:54`; `backend/internal/api/routes/routes.go:89` |
| 113 | `workflowService.saveCanvas` | `PUT /workflows/:id/canvas` | `PutWorkflowCanvas` | Yes | `frontend/src/services/workflow.service.js:57`; `backend/internal/api/routes/routes.go:91` |
| 114 | `workflowService.publish` | `POST /workflows/:id/publish` | `PublishWorkflow` | Yes | `frontend/src/services/workflow.service.js:60`; `backend/internal/api/routes/routes.go:82` |
| 115 | `workflowService.run` | `POST /workflows/:id/run` | `RunWorkflow` | Yes | `frontend/src/services/workflow.service.js:62-69`; `backend/internal/api/routes/routes.go:85` |
| 116 | `workflowService.assignUser` | `POST /workflows/:id/assign` | `AssignWorkflowUser` | Yes | `frontend/src/services/workflow.service.js:72`; `backend/internal/api/routes/routes.go:86` |
| 117 | `workflowService.unassignUser` | `DELETE /workflows/:id/assign/:userId` | `UnassignWorkflowUser` | Yes | `frontend/src/services/workflow.service.js:75`; `backend/internal/api/routes/routes.go:87` |
| 118 | Top bar health query | `GET /health` | `Health` | Yes | `frontend/src/components/navigation/Topbar.jsx:104`; `backend/internal/api/routes/routes.go:17` |

## Pairing result

- Frontend path absent from backend registration: **0**.
- Frontend method differs from backend registration: **0**.
- Paired frontend call sites: **118**.
- Dynamic registry calls are paired only for the two values the UI supplies, `tools` and `rules`; any other runtime `kind` would be unregistered and is outside the current UI contract (`frontend/src/pages/registry/RegistryPage.jsx:32-40,112-116`; `backend/internal/api/routes/routes.go:112-118`).

## Registered backend routes with no direct frontend caller

These are orphaned surface area, not frontend/backend mismatches. Grouped routes retain their registered method and path.

- Platform/realtime: `GET /healthz`, `GET /ws/*` (`backend/internal/api/routes/routes.go:13-14`; no matching call in the complete frontend HTTP inventory above).
- Auth: `GET /auth/oauth/:provider/callback`, `POST /auth/2fa/enable`, `POST /auth/2fa/disable` (`backend/internal/api/routes/routes.go:28,49-50`; frontend auth calls are rows 10-20).
- Company collection reads: `GET /company/cost-centres`, `GET /company/approval-tiers` (`backend/internal/api/routes/routes.go:58,62`; company-service calls are rows 28-38).
- Workflow lifecycle: `POST /workflows/templates`, `POST /workflows/:id/duplicate`, `POST /workflows/:id/archive`, `POST /workflows/:id/validate`, `GET /workflows/:id/versions`, `POST /workflows/:id/restore/:versionId`, `GET /workflows/:id/executions` (`backend/internal/api/routes/routes.go:73,81,83-84,92-94`; workflow-service calls are rows 103-117).
- Direct generation/catalog: `POST /synthesis/validate`, `POST /synthesis/preview-flow`, `POST /synthesis/explain`, `GET /rules/catalog`, `POST /canvas/validate-workflow` (`backend/internal/api/routes/routes.go:97-99,101,106`; synthesis/catalog calls are rows 21,86-87).
- Execution: `POST /executions/:id/cancel` (`backend/internal/api/routes/routes.go:135`; execution calls are rows 43-49).
- User/audit: `POST /users/invite`, `GET /users/:id`, `DELETE /users/:id`, `POST /users/:id/activate`, `POST /users/:id/suspend`, `GET /roles/:id`, `PATCH /roles/:id`, `GET /audit/export`, `GET /audit/:id` (`backend/internal/api/routes/routes.go:149-167`; user/audit calls are rows 9,89-102).
- Profile: `PATCH /profile/security`, `GET/PATCH /profile/notifications`, `POST /profile/api-keys`, `DELETE /profile/api-keys/:id` (`backend/internal/api/routes/routes.go:171-176`; profile/settings calls are rows 58-59,78).
- Settings: `GET/PATCH /settings/general`, `GET/PATCH /settings/llm`, `GET/PATCH /settings/rbac`, `PATCH/DELETE /settings/webhooks/:id`, `POST /settings/webhooks/:id/test` (`backend/internal/api/routes/routes.go:180-195`; settings calls are rows 75-85).
- Integrations: `GET /integrations/:id`, `PATCH /integrations/:id`, `DELETE /integrations/:id` (`backend/internal/api/routes/routes.go:199-201`; integration calls are rows 50-54,76).
- Notifications/uploads: `DELETE /notifications/:id`, `GET /upload/:id`, `GET /upload/:id/download`, `DELETE /upload/:id`, `POST /upload/workflow-import` (`backend/internal/api/routes/routes.go:209,211-214`; notification/upload calls are rows 55-57,88).

No BREAKS finding exists at the route-pairing level. Body, response, and error compatibility are assessed in the following documents rather than inferred from matching route names.
