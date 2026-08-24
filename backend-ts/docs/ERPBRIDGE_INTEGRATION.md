# ERPBridge MCP integration

## Scope

The workflow engine uses the ERPBridge Streamable HTTP MCP endpoint at `/mcp/`.

The engine does not call the admin-only `/api/tools/invoke` endpoint.

The engine does not receive the ERPBridge admin credential.

The engine uses `@erpbridge/sdk@1.1.0` inside a private governed adapter.

The adapter sets `mcpRetryPolicy: "never"`. A transport failure does not cause a second tool call.

## Configuration

Set these environment variables when you select ERPBridge MCP:

| Variable | Required | Description |
| --- | --- | --- |
| `MCP_TRANSPORT` | Yes | Set to `erpbridge-mcp`. The default is `bridge-v1`. |
| `ERPBRIDGE_BASE_URL` | Yes | Base URL of the ERPBridge server. Use HTTPS outside development. |
| `ERPBRIDGE_MCP_TOKEN` | One source | Scoped bearer token with the `mcp` scope. |
| `ERPBRIDGE_MCP_TOKEN_ENV` | One source | Name of the environment variable that stores the token. |
| `ERPBRIDGE_ROLE_MAP` | Yes | Strict JSON map from local role names to ERPBridge roles. |

Do not set both token variables. The engine rejects that configuration.

Do not put a token in a workflow, YAML file, registry value, log, or public API response.

Example:

```bash
MCP_TRANSPORT=erpbridge-mcp
ERPBRIDGE_BASE_URL=https://erpbridge.example
ERPBRIDGE_MCP_TOKEN_ENV=WORKFLOW_ERPBRIDGE_TOKEN
ERPBRIDGE_ROLE_MAP='{"Platform Admin":"platform_admin","System Admin":"system_admin","Workflow Builder":"workflow_builder","Client":"client"}'
```

## Role matrix

The local role is the authenticated workflow-engine role.

The ERPBridge role is a selector in a guarded MCP call.

ERPBridge authenticates the service token. It does not authenticate the human user.

| Workflow-engine role | ERPBridge token role | Guarded tool `allowedRoles` |
| --- | --- | --- |
| Platform Admin | `platform_admin` | `platform_admin` |
| System Admin | `system_admin` | `system_admin` |
| Workflow Builder | `workflow_builder` | `workflow_builder` |
| Client | `client` | `client` |

Use only the rows required by the deployment. A token for a test deployment can contain only `workflow_builder` and `client`.

The local registry remains the source of truth for tool names, input schemas, risk, side effects, and local role access.

## Token provisioning

Create tokens with an administrator credential. Use the credential only for token administration.

Do not send the administrator credential to the workflow engine.

```bash
export BRIDGE_API_TOKEN='[REDACTED]'
bridgectl --context local token create \
  --name lcwe-production-mcp \
  --scope mcp \
  --role workflow_builder \
  --role client \
  --expires 720h
unset BRIDGE_API_TOKEN
```

Store the returned `erpbt_` value in the deployment secret manager as `ERPBRIDGE_MCP_TOKEN`.

Record the token name, scopes, roles, and expiry. Do not record the token value in source control.

Create a replacement token before the current token expires. Update the deployment secret. Revoke the old token after the new token works.

```bash
export BRIDGE_API_TOKEN='[REDACTED]'
bridgectl --context local token revoke '<token-id>'
unset BRIDGE_API_TOKEN
```

## Deployment checks

Run these checks against a non-production ERPBridge server:

1. An allowed MCP tool call succeeds.
2. A token without `mcp` receives HTTP 403.
3. A revoked token receives HTTP 401.
4. A role absent from the token fails at ERPBridge.
5. A role absent from the tool allow-list fails at ERPBridge.
6. A transport failure produces one tool-call attempt.
7. A registry drift report fails the check and does not change the local registry.

Run the local registry check with the configured scoped token:

```bash
MCP_TRANSPORT=erpbridge-mcp \
ERPBRIDGE_BASE_URL=https://erpbridge.example \
ERPBRIDGE_MCP_TOKEN_ENV=WORKFLOW_ERPBRIDGE_TOKEN \
ERPBRIDGE_ROLE_MAP='{"Workflow Builder":"workflow_builder","Client":"client"}' \
npm run verify:erpbridge-registry
```

## Audit boundary

The workflow engine records the authenticated user ID and execution ID in its audit records.

ERPBridge records the service-token identity and the selected ERPBridge role.

The selected role is derived from the authenticated local user. A workflow cannot set or replace this role.

The adapter returns the complete MCP result envelope. It does not parse arbitrary text content into a business object.
