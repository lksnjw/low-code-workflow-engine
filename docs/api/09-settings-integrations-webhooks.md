# Settings, Integrations, and Webhooks API

Base paths: `/api/settings`, `/api/integrations`

## Settings Endpoints

| Method | Endpoint | Auth | Request Body | Success Response |
|---|---|---|---|---|
| `GET` | `/settings` | Required | none | `SettingsBundle` |
| `PATCH` | `/settings` | Required | `SettingsBundlePatch` | `SettingsBundle` |
| `GET` | `/settings/general` | Required | none | `GeneralSettings` |
| `PATCH` | `/settings/general` | Required | `GeneralSettingsPatch` | `GeneralSettings` |
| `GET` | `/settings/llm` | Required | none | `LlmSettings` |
| `PATCH` | `/settings/llm` | Required | `LlmSettingsPatch` | `LlmSettings` |
| `GET` | `/settings/rbac` | Required | none | `RbacPolicy` |
| `PATCH` | `/settings/rbac` | Required | `RbacPolicy` | `RbacPolicy` |

## Webhook Endpoints

| Method | Endpoint | Auth | Request Body | Success Response |
|---|---|---|---|---|
| `GET` | `/settings/webhooks` | Required | none | `Webhook[]` |
| `POST` | `/settings/webhooks` | Required | `CreateWebhookRequest` | `Webhook` |
| `PATCH` | `/settings/webhooks/:id` | Required | `UpdateWebhookRequest` | `Webhook` |
| `DELETE` | `/settings/webhooks/:id` | Required | none | `{ "deleted": true }` |
| `POST` | `/settings/webhooks/:id/test` | Required | none | `WebhookTestResult` |

## Integration Endpoints

| Method | Endpoint | Auth | Request Body | Success Response |
|---|---|---|---|---|
| `GET` | `/integrations` | Required | query: `type`, `status` | `Integration[]` |
| `POST` | `/integrations` | Required | `CreateIntegrationRequest` | `Integration` |
| `GET` | `/integrations/:id` | Required | none | `IntegrationDetail` |
| `PATCH` | `/integrations/:id` | Required | `UpdateIntegrationRequest` | `Integration` |
| `DELETE` | `/integrations/:id` | Required | none | `{ "deleted": true }` |
| `POST` | `/integrations/:id/test` | Required | none | `IntegrationTestResult` |
| `POST` | `/integrations/:id/connect` | Required | credentials/config | `Integration` |
| `POST` | `/integrations/:id/disconnect` | Required | none | `Integration` |

## Settings Bundle Response

```json
{
  "success": true,
  "data": {
    "general": {
      "appName": "Agentic Workflow Engine",
      "defaultTimezone": "Asia/Colombo",
      "branding": {
        "primaryColor": "#84006A"
      }
    },
    "llm": {
      "defaultModel": "gpt-5.4",
      "fallbackModel": "gpt-5.4-mini",
      "policyMode": "guarded",
      "systemPrompt": "You are the workflow synthesis agent."
    },
    "rbac": {
      "productionRunRequiresApproval": true,
      "publicRegistrationEnabled": false,
      "defaultRoleId": "role_client"
    }
  },
  "message": "OK",
  "meta": null
}
```

## Integration Response

```json
{
  "success": true,
  "data": {
    "id": "int_erp_sandbox",
    "name": "ERP Sandbox",
    "type": "MCP Server",
    "status": "Connected",
    "icon": "mdi:server",
    "config": {
      "baseUrl": "https://erp.example.local",
      "timeoutMs": 15000
    },
    "lastTestedAt": "2026-05-02T09:40:00Z",
    "createdAt": "2026-05-01T08:00:00Z"
  },
  "message": "OK",
  "meta": null
}
```

## Webhook Response

```json
{
  "success": true,
  "data": {
    "id": "wh_001",
    "name": "Workflow Events",
    "url": "https://example.com/workflow-events",
    "events": [
      "execution.started",
      "execution.completed",
      "execution.failed",
      "healing.recovered"
    ],
    "enabled": true,
    "secretPreview": "whsec_....2F91",
    "createdAt": "2026-05-02T09:45:00Z"
  },
  "message": "OK",
  "meta": null
}
```

