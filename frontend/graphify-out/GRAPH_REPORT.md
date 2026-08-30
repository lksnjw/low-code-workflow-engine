# Graph Report - frontend  (2026-08-28)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 845 nodes · 1766 edges · 92 communities (77 shown, 15 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 3 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `bb4160b7`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18
- Community 19
- Community 20
- Community 21
- Community 22
- Community 23
- Community 24
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 30
- Community 32
- Community 33
- Community 35
- Community 36
- Community 37
- Community 38
- Community 60
- Community 62
- Community 63
- Community 64

## God Nodes (most connected - your core abstractions)
1. `Card()` - 39 edges
2. `usePermissions()` - 38 edges
3. `apiErrorMessage()` - 35 edges
4. `apiClient` - 29 edges
5. `LoadingState()` - 28 edges
6. `ErrorState()` - 26 edges
7. `Button()` - 26 edges
8. `useNotifications()` - 24 edges
9. `useAuthContext()` - 24 edges
10. `useRoute()` - 23 edges

## Surprising Connections (you probably didn't know these)
- `ProtectedScreen()` --calls--> `usePermissions()`  [EXTRACTED]
  src/config/router.jsx → src/hooks/usePermissions.js
- `RegistryImportPage()` --calls--> `apiErrorMessage()`  [EXTRACTED]
  src/pages/registry/RegistryImportPage.jsx → src/services/api.js
- `RegisterPage()` --calls--> `useAuthContext()`  [EXTRACTED]
  src/pages/auth/RegisterPage.jsx → src/context/AuthContext.jsx
- `WorkflowAssignments()` --calls--> `useNotifications()`  [EXTRACTED]
  src/components/workflows/WorkflowAssignments.jsx → src/context/NotificationContext.jsx
- `WorkflowAssignments()` --calls--> `apiErrorMessage()`  [EXTRACTED]
  src/components/workflows/WorkflowAssignments.jsx → src/services/api.js

## Import Cycles
- None detected.

## Communities (92 total, 15 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (30): BarChart(), DonutChart(), F1ScoreGauge(), HealingSuccessRate(), HeatmapCalendar(), LineChart(), MetricCard(), UsageTrendCard() (+22 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (24): ACTION_ICON, ChatArtifactPanel(), DECISION_COLORS, METHOD_COLORS, NEXT_ACTION_META, RISK_COLORS, RULE_TYPE_COLORS, ChatHistory() (+16 more)

### Community 2 - "Community 2"
Cohesion: 0.07
Nodes (25): ExecutionTable(), HealingReport(), ErrorState(), LoadingState(), notify, permissions, rebuild, registryCreate (+17 more)

### Community 3 - "Community 3"
Cohesion: 0.09
Nodes (22): RecentWorkflows(), policyFailure, toolFailure, doneExecution, failedExecution, ExecutionOutputPanel(), format(), OutputBlock() (+14 more)

### Community 4 - "Community 4"
Cohesion: 0.07
Nodes (12): ExecutionFilters(), Avatar(), Input(), Select(), Spinner(), UserBadge(), UserRow(), UserTable() (+4 more)

### Community 5 - "Community 5"
Cohesion: 0.05
Nodes (41): autoprefixer, @babel/core, babel-jest, @babel/preset-react, eslint, @eslint/js, eslint-plugin-react-hooks, eslint-plugin-react-refresh (+33 more)

### Community 6 - "Community 6"
Cohesion: 0.06
Nodes (35): axios, @iconify/react, js-yaml, lucide-react, dependencies, axios, @iconify/react, js-yaml (+27 more)

### Community 7 - "Community 7"
Cohesion: 0.10
Nodes (23): BuilderModeControls(), getInitialCanvasState(), iconMap, statusMeta, toneClasses, WorkflowBuilderSurface(), WorkflowToolNode(), TraceIdentifier() (+15 more)

### Community 8 - "Community 8"
Cohesion: 0.13
Nodes (14): notify, notify, notify, apiClient, NON_REFRESHABLE, formatDuration(), formatTokens(), unwrap() (+6 more)

### Community 9 - "Community 9"
Cohesion: 0.13
Nodes (11): Topbar(), UserMenu(), appConfig, websocketOrigin, ThemeContext, useTheme(), useClickOutside(), AuthLayout() (+3 more)

### Community 10 - "Community 10"
Cohesion: 0.11
Nodes (12): features, disabledPaths, allProtectedRouteDefinitions, appRouteObjects, authPaths, lazyRouteComponents, navigationRouteIds, protectedChildren (+4 more)

### Community 11 - "Community 11"
Cohesion: 0.15
Nodes (11): RegistryGenerationContextViewer(), RegistryStatusBanner(), EmptyState(), RegistryImportPage(), REVIEW_GROUPS, NEW_RULE, NEW_TOOL, pretty() (+3 more)

### Community 12 - "Community 12"
Cohesion: 0.19
Nodes (13): BuilderLoadState(), BuilderSidebar(), Checkbox(), PermissionMatrix(), restrictPermissionsToCaller(), RoleCreateForm(), BUILT_IN_ROLE_IDS, RolePermissionEditor() (+5 more)

### Community 13 - "Community 13"
Cohesion: 0.14
Nodes (15): FormField(), Textarea(), ApprovalTiersTab(), CostCentresTab(), DepartmentsTab(), EMPTY_APPROVAL_TIER, EMPTY_COST_CENTRE, EMPTY_DEPARTMENT (+7 more)

### Community 14 - "Community 14"
Cohesion: 0.17
Nodes (14): CommandPalette(), hasAnyFor(), ROLE_IDS, ROLES, routeByPath, visibleNavEntries(), protectedRouteDefinitions, allNavigationGroups (+6 more)

### Community 15 - "Community 15"
Cohesion: 0.14
Nodes (8): AUTH_STORAGE, getRefreshInFlight(), isNetworkError(), isServerUnavailable(), AuthContext, AuthProvider(), loadCurrentUser(), loadStoredUser()

### Community 16 - "Community 16"
Cohesion: 0.18
Nodes (10): WebhookForm(), CopyButton(), TemplateCard(), NotificationContext, useNotifications(), COLUMNS, EMPTY_FORM, ModelsPage() (+2 more)

### Community 17 - "Community 17"
Cohesion: 0.18
Nodes (8): ServerUnreachableBanner(), AuthStateProbe(), AuthenticatedRoute(), PublicScreen(), useAuthContext(), useAuth(), LoginPage(), SecurityPage()

### Community 18 - "Community 18"
Cohesion: 0.21
Nodes (9): WorkflowBuilderCanvas(), MobileNav(), usePermissions(), CompanyPage(), RegistryContextPage(), WorkflowBuilderPage(), hasAnyPermission(), hasPermission() (+1 more)

### Community 20 - "Community 20"
Cohesion: 0.18
Nodes (6): App(), queryClient, ErrorBoundary, appRouter, NotificationProvider(), ThemeProvider()

### Community 21 - "Community 21"
Cohesion: 0.24
Nodes (3): Button(), variants, Modal()

### Community 22 - "Community 22"
Cohesion: 0.27
Nodes (8): QuickActions(), WelcomeBanner(), useRoute(), useDashboard(), useWorkflows(), DashboardPage(), WorkflowListPage(), dashboardService

### Community 23 - "Community 23"
Cohesion: 0.25
Nodes (6): columns, DataTable(), Tabs(), WorkflowCard(), columns, WorkflowTable()

### Community 24 - "Community 24"
Cohesion: 0.43
Nodes (6): Breadcrumb(), getNavigationGroup(), RouteContext, routeFromPath(), RouteProvider(), workflowIDFromPath()

### Community 25 - "Community 25"
Cohesion: 0.29
Nodes (3): RegistryBulkImportPanel(), bulkImport, context

### Community 26 - "Community 26"
Cohesion: 0.33
Nodes (5): compilerOptions, baseUrl, paths, include, src

## Knowledge Gaps
- **123 isolated node(s):** `tones`, `toneClasses`, `ACTION_ICON`, `DECISION_COLORS`, `METHOD_COLORS` (+118 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **15 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `usePermissions()` connect `Community 18` to `Community 0`, `Community 1`, `Community 2`, `Community 7`, `Community 10`, `Community 11`, `Community 12`, `Community 13`, `Community 14`, `Community 17`, `Community 22`, `Community 23`, `Community 24`, `Community 25`, `Community 27`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **Why does `Card()` connect `Community 0` to `Community 2`, `Community 3`, `Community 4`, `Community 12`, `Community 13`, `Community 16`, `Community 17`, `Community 22`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **Why does `useAuthContext()` connect `Community 17` to `Community 4`, `Community 9`, `Community 10`, `Community 12`, `Community 15`, `Community 18`?**
  _High betweenness centrality (0.020) - this node is a cross-community bridge._
- **What connects `tones`, `toneClasses`, `ACTION_ICON` to the rest of the system?**
  _123 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.056535504296698326 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.05370101596516691 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.07482993197278912 - nodes in this community are weakly interconnected._