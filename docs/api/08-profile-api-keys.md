# Profile and API Keys API

Base paths: `/api/profile`, `/api/profile/api-keys`

## Profile Endpoints

| Method | Endpoint | Auth | Request Body | Success Response |
|---|---|---|---|---|
| `GET` | `/profile` | Required | none | `Profile` |
| `PATCH` | `/profile` | Required | `UpdateProfileRequest` | `Profile` |
| `PATCH` | `/profile/security` | Required | `UpdateSecurityRequest` | `SecuritySettings` |
| `GET` | `/profile/notifications` | Required | none | `NotificationPreferences` |
| `PATCH` | `/profile/notifications` | Required | `NotificationPreferences` | `NotificationPreferences` |

## API Key Endpoints

| Method | Endpoint | Auth | Request Body | Success Response |
|---|---|---|---|---|
| `GET` | `/profile/api-keys` | Required | none | `ApiKey[]` |
| `POST` | `/profile/api-keys` | Required | `CreateApiKeyRequest` | `CreatedApiKey` |
| `DELETE` | `/profile/api-keys/:id` | Required | none | `{ "revoked": true }` |

## Profile Response

```json
{
  "success": true,
  "data": {
    "id": "usr_001",
    "name": "Lakshan Jay",
    "email": "admin@workflow.local",
    "role": "Platform Admin",
    "timezone": "Asia/Colombo",
    "avatarUrl": null,
    "twoFactorEnabled": true
  },
  "message": "OK",
  "meta": null
}
```

## Update Security Request

```json
{
  "currentPassword": "OldPassword123!",
  "newPassword": "NewPassword123!",
  "twoFactorEnabled": true,
  "requireApprovalBeforeProductionRuns": true
}
```

## Notification Preferences Response

```json
{
  "success": true,
  "data": {
    "executionFailures": true,
    "healingEvents": true,
    "budgetWarnings": true,
    "weeklyReports": false,
    "channels": {
      "inApp": true,
      "email": true,
      "webhook": false
    }
  },
  "message": "OK",
  "meta": null
}
```

## Created API Key Response

```json
{
  "success": true,
  "data": {
    "id": "key_001",
    "name": "Local development",
    "key": "wf_live_[REDACTED]",
    "maskedKey": "wf_live_................2F91",
    "scopes": ["workflow:read", "workflow:run"],
    "createdAt": "2026-05-02T09:40:00Z",
    "expiresAt": null
  },
  "message": "API key created. Store the key now; it will not be shown again.",
  "meta": null
}
```

