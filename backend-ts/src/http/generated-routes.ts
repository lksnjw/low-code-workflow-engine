// Generated from the live Go Fiber route graph. Do not hand-edit.
export const routeTable = [
  {
    "method": "GET",
    "path": "/api/analytics/activity-heatmap"
  },
  {
    "method": "GET",
    "path": "/api/analytics/cost-trends"
  },
  {
    "method": "GET",
    "path": "/api/analytics/f1-score"
  },
  {
    "method": "GET",
    "path": "/api/analytics/latency"
  },
  {
    "method": "GET",
    "path": "/api/analytics/performance"
  },
  {
    "method": "GET",
    "path": "/api/analytics/self-healing"
  },
  {
    "method": "GET",
    "path": "/api/analytics/summary"
  },
  {
    "method": "GET",
    "path": "/api/analytics/usage"
  },
  {
    "method": "GET",
    "path": "/api/audit"
  },
  {
    "method": "GET",
    "path": "/api/audit/:id"
  },
  {
    "method": "GET",
    "path": "/api/audit/export"
  },
  {
    "method": "POST",
    "path": "/api/auth/2fa/disable"
  },
  {
    "method": "POST",
    "path": "/api/auth/2fa/enable"
  },
  {
    "method": "POST",
    "path": "/api/auth/2fa/verify"
  },
  {
    "method": "POST",
    "path": "/api/auth/forgot-password"
  },
  {
    "method": "POST",
    "path": "/api/auth/login"
  },
  {
    "method": "POST",
    "path": "/api/auth/logout"
  },
  {
    "method": "GET",
    "path": "/api/auth/me"
  },
  {
    "method": "GET",
    "path": "/api/auth/oauth/:provider/authorize"
  },
  {
    "method": "GET",
    "path": "/api/auth/oauth/:provider/callback"
  },
  {
    "method": "POST",
    "path": "/api/auth/refresh"
  },
  {
    "method": "POST",
    "path": "/api/auth/register"
  },
  {
    "method": "POST",
    "path": "/api/auth/reset-password"
  },
  {
    "method": "POST",
    "path": "/api/auth/verify-email"
  },
  {
    "method": "POST",
    "path": "/api/canvas/validate-workflow"
  },
  {
    "method": "GET",
    "path": "/api/chat/sessions"
  },
  {
    "method": "POST",
    "path": "/api/chat/sessions"
  },
  {
    "method": "DELETE",
    "path": "/api/chat/sessions/:id"
  },
  {
    "method": "GET",
    "path": "/api/chat/sessions/:id"
  },
  {
    "method": "PATCH",
    "path": "/api/chat/sessions/:id"
  },
  {
    "method": "POST",
    "path": "/api/chat/sessions/:id/messages"
  },
  {
    "method": "GET",
    "path": "/api/company"
  },
  {
    "method": "PUT",
    "path": "/api/company"
  },
  {
    "method": "GET",
    "path": "/api/company/approval-tiers"
  },
  {
    "method": "POST",
    "path": "/api/company/approval-tiers"
  },
  {
    "method": "DELETE",
    "path": "/api/company/approval-tiers/:id"
  },
  {
    "method": "PUT",
    "path": "/api/company/approval-tiers/:id"
  },
  {
    "method": "GET",
    "path": "/api/company/cost-centres"
  },
  {
    "method": "POST",
    "path": "/api/company/cost-centres"
  },
  {
    "method": "DELETE",
    "path": "/api/company/cost-centres/:id"
  },
  {
    "method": "PUT",
    "path": "/api/company/cost-centres/:id"
  },
  {
    "method": "GET",
    "path": "/api/company/departments"
  },
  {
    "method": "POST",
    "path": "/api/company/departments"
  },
  {
    "method": "DELETE",
    "path": "/api/company/departments/:id"
  },
  {
    "method": "PUT",
    "path": "/api/company/departments/:id"
  },
  {
    "method": "GET",
    "path": "/api/dashboard/activity"
  },
  {
    "method": "GET",
    "path": "/api/dashboard/health"
  },
  {
    "method": "GET",
    "path": "/api/dashboard/recent-workflows"
  },
  {
    "method": "GET",
    "path": "/api/dashboard/summary"
  },
  {
    "method": "GET",
    "path": "/api/executions"
  },
  {
    "method": "GET",
    "path": "/api/executions/:id"
  },
  {
    "method": "POST",
    "path": "/api/executions/:id/cancel"
  },
  {
    "method": "GET",
    "path": "/api/executions/:id/healing-report"
  },
  {
    "method": "GET",
    "path": "/api/executions/:id/logs"
  },
  {
    "method": "POST",
    "path": "/api/executions/:id/retry"
  },
  {
    "method": "GET",
    "path": "/api/executions/:id/timeline"
  },
  {
    "method": "GET",
    "path": "/api/health"
  },
  {
    "method": "POST",
    "path": "/api/import/analyse"
  },
  {
    "method": "POST",
    "path": "/api/import/commit"
  },
  {
    "method": "GET",
    "path": "/api/import/history"
  },
  {
    "method": "GET",
    "path": "/api/integrations"
  },
  {
    "method": "POST",
    "path": "/api/integrations"
  },
  {
    "method": "DELETE",
    "path": "/api/integrations/:id"
  },
  {
    "method": "GET",
    "path": "/api/integrations/:id"
  },
  {
    "method": "PATCH",
    "path": "/api/integrations/:id"
  },
  {
    "method": "POST",
    "path": "/api/integrations/:id/connect"
  },
  {
    "method": "POST",
    "path": "/api/integrations/:id/disconnect"
  },
  {
    "method": "POST",
    "path": "/api/integrations/:id/test"
  },
  {
    "method": "GET",
    "path": "/api/notifications"
  },
  {
    "method": "DELETE",
    "path": "/api/notifications/:id"
  },
  {
    "method": "PATCH",
    "path": "/api/notifications/:id/read"
  },
  {
    "method": "PATCH",
    "path": "/api/notifications/read-all"
  },
  {
    "method": "GET",
    "path": "/api/permissions"
  },
  {
    "method": "GET",
    "path": "/api/permissions/matrix"
  },
  {
    "method": "GET",
    "path": "/api/profile"
  },
  {
    "method": "PATCH",
    "path": "/api/profile"
  },
  {
    "method": "GET",
    "path": "/api/profile/api-keys"
  },
  {
    "method": "POST",
    "path": "/api/profile/api-keys"
  },
  {
    "method": "DELETE",
    "path": "/api/profile/api-keys/:id"
  },
  {
    "method": "GET",
    "path": "/api/profile/notifications"
  },
  {
    "method": "PATCH",
    "path": "/api/profile/notifications"
  },
  {
    "method": "PATCH",
    "path": "/api/profile/security"
  },
  {
    "method": "GET",
    "path": "/api/providers"
  },
  {
    "method": "POST",
    "path": "/api/providers"
  },
  {
    "method": "PUT",
    "path": "/api/providers/:id"
  },
  {
    "method": "POST",
    "path": "/api/providers/:id/activate"
  },
  {
    "method": "POST",
    "path": "/api/providers/:id/test"
  },
  {
    "method": "GET",
    "path": "/api/registry/context"
  },
  {
    "method": "GET",
    "path": "/api/registry/context/history"
  },
  {
    "method": "POST",
    "path": "/api/registry/context/regenerate"
  },
  {
    "method": "GET",
    "path": "/api/registry/rules"
  },
  {
    "method": "POST",
    "path": "/api/registry/rules"
  },
  {
    "method": "PUT",
    "path": "/api/registry/rules/:id"
  },
  {
    "method": "POST",
    "path": "/api/registry/rules/import"
  },
  {
    "method": "GET",
    "path": "/api/registry/status"
  },
  {
    "method": "GET",
    "path": "/api/registry/tools"
  },
  {
    "method": "POST",
    "path": "/api/registry/tools"
  },
  {
    "method": "PUT",
    "path": "/api/registry/tools/:id"
  },
  {
    "method": "POST",
    "path": "/api/registry/tools/import"
  },
  {
    "method": "GET",
    "path": "/api/roles"
  },
  {
    "method": "POST",
    "path": "/api/roles"
  },
  {
    "method": "DELETE",
    "path": "/api/roles/:id"
  },
  {
    "method": "GET",
    "path": "/api/roles/:id"
  },
  {
    "method": "PATCH",
    "path": "/api/roles/:id"
  },
  {
    "method": "PUT",
    "path": "/api/roles/:id"
  },
  {
    "method": "GET",
    "path": "/api/rules/catalog"
  },
  {
    "method": "GET",
    "path": "/api/semantic-index/health"
  },
  {
    "method": "GET",
    "path": "/api/semantic-index/metadata"
  },
  {
    "method": "POST",
    "path": "/api/semantic-index/rebuild"
  },
  {
    "method": "POST",
    "path": "/api/semantic-search"
  },
  {
    "method": "GET",
    "path": "/api/settings"
  },
  {
    "method": "PATCH",
    "path": "/api/settings"
  },
  {
    "method": "GET",
    "path": "/api/settings/general"
  },
  {
    "method": "PATCH",
    "path": "/api/settings/general"
  },
  {
    "method": "GET",
    "path": "/api/settings/llm"
  },
  {
    "method": "PATCH",
    "path": "/api/settings/llm"
  },
  {
    "method": "GET",
    "path": "/api/settings/rbac"
  },
  {
    "method": "PATCH",
    "path": "/api/settings/rbac"
  },
  {
    "method": "GET",
    "path": "/api/settings/webhooks"
  },
  {
    "method": "POST",
    "path": "/api/settings/webhooks"
  },
  {
    "method": "DELETE",
    "path": "/api/settings/webhooks/:id"
  },
  {
    "method": "PATCH",
    "path": "/api/settings/webhooks/:id"
  },
  {
    "method": "POST",
    "path": "/api/settings/webhooks/:id/test"
  },
  {
    "method": "POST",
    "path": "/api/synthesis"
  },
  {
    "method": "POST",
    "path": "/api/synthesis/explain"
  },
  {
    "method": "POST",
    "path": "/api/synthesis/preview-flow"
  },
  {
    "method": "POST",
    "path": "/api/synthesis/validate"
  },
  {
    "method": "GET",
    "path": "/api/tools/catalog"
  },
  {
    "method": "POST",
    "path": "/api/upload"
  },
  {
    "method": "DELETE",
    "path": "/api/upload/:id"
  },
  {
    "method": "GET",
    "path": "/api/upload/:id"
  },
  {
    "method": "GET",
    "path": "/api/upload/:id/download"
  },
  {
    "method": "POST",
    "path": "/api/upload/workflow-import"
  },
  {
    "method": "GET",
    "path": "/api/users"
  },
  {
    "method": "POST",
    "path": "/api/users"
  },
  {
    "method": "DELETE",
    "path": "/api/users/:id"
  },
  {
    "method": "GET",
    "path": "/api/users/:id"
  },
  {
    "method": "PATCH",
    "path": "/api/users/:id"
  },
  {
    "method": "POST",
    "path": "/api/users/:id/activate"
  },
  {
    "method": "PUT",
    "path": "/api/users/:id/role"
  },
  {
    "method": "PUT",
    "path": "/api/users/:id/status"
  },
  {
    "method": "POST",
    "path": "/api/users/:id/suspend"
  },
  {
    "method": "POST",
    "path": "/api/users/invite"
  },
  {
    "method": "GET",
    "path": "/api/workflows"
  },
  {
    "method": "POST",
    "path": "/api/workflows"
  },
  {
    "method": "DELETE",
    "path": "/api/workflows/:id"
  },
  {
    "method": "GET",
    "path": "/api/workflows/:id"
  },
  {
    "method": "PATCH",
    "path": "/api/workflows/:id"
  },
  {
    "method": "POST",
    "path": "/api/workflows/:id/archive"
  },
  {
    "method": "POST",
    "path": "/api/workflows/:id/assign"
  },
  {
    "method": "DELETE",
    "path": "/api/workflows/:id/assign/:userId"
  },
  {
    "method": "GET",
    "path": "/api/workflows/:id/canvas"
  },
  {
    "method": "PUT",
    "path": "/api/workflows/:id/canvas"
  },
  {
    "method": "POST",
    "path": "/api/workflows/:id/duplicate"
  },
  {
    "method": "GET",
    "path": "/api/workflows/:id/executions"
  },
  {
    "method": "POST",
    "path": "/api/workflows/:id/publish"
  },
  {
    "method": "POST",
    "path": "/api/workflows/:id/restore/:versionId"
  },
  {
    "method": "POST",
    "path": "/api/workflows/:id/run"
  },
  {
    "method": "POST",
    "path": "/api/workflows/:id/validate"
  },
  {
    "method": "GET",
    "path": "/api/workflows/:id/versions"
  },
  {
    "method": "GET",
    "path": "/api/workflows/:id/yaml"
  },
  {
    "method": "PUT",
    "path": "/api/workflows/:id/yaml"
  },
  {
    "method": "GET",
    "path": "/api/workflows/assignable-users"
  },
  {
    "method": "GET",
    "path": "/api/workflows/templates"
  },
  {
    "method": "POST",
    "path": "/api/workflows/templates"
  },
  {
    "method": "POST",
    "path": "/api/workflows/templates/:id/use"
  },
  {
    "method": "GET",
    "path": "/healthz"
  },
  {
    "method": "GET",
    "path": "/ws/*"
  }
] as const;
export type RouteDefinition = (typeof routeTable)[number];
