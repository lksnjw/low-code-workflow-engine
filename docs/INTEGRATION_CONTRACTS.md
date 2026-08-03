# Integration Contracts

## MCP tool execution

The standalone mock ERP and Nimendra's real bridge implement the same
downstream MCP contract. Switching from the mock ERP to the real bridge is a
change to `MCP_BASE_URL` only. The runner, validation gate, registry, and
workflow definitions do not change.

### Request

```http
POST <MCP_BASE_URL>/tools/execute
Content-Type: application/json
```

```json
{
  "action": "<registry tool name>",
  "parameters": {
    "_action": "<registry tool name>",
    "<resolved parameter>": "<value>"
  }
}
```

The `action` value is the runtime registry tool's `name`, because that is what
the runner sends. A bridge must also accept the tool's `mcp_tool_name` as an
alias for the same handler. `_action`, when present, must resolve to that same
tool.

### Success

- Any HTTP status below 400 is treated as success.
- The response body must be one JSON object.
- The response must not be `204 No Content` and must not be a JSON array,
  because the client decodes the body into an object.
- There is no required response envelope.

Example:

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
  "status": "success",
  "purchaseOrder": {
    "number": "PO-123"
  }
}
```

### Failure status mapping

| Failure | HTTP status | Execute category | Healing |
|---|---:|---|---|
| Invalid parameters or request | `400` | `INVALID_REQUEST` | Never |
| Authentication or authorization denied by the bridge | `401` | `AUTH_DENIED` | Never |
| Tool or requested fixture entity not found | `404` | `NOT_FOUND` | Never |
| Temporary downstream failure | `500`–`599` | `TRANSIENT` | Eligible |
| Timeout or connection refusal | No response | `TRANSIENT` | Eligible |
| Any unrecognised failure | Other | Terminal, fail closed | Never |

The client deliberately discards all downstream error response bodies. A
bridge may return a JSON error object for its own observability, but must not
expect the orchestration server to parse or expose it. This prevents
credentials or internal diagnostics in a downstream body from reaching
browser messages.

A dispatch policy violation occurs before this contract is invoked. The
bridge receives no request for a policy-blocked step and must not implement
registry policy logic.

## Mock ERP operational endpoints

These endpoints are specific to the standalone demo service and are not
requirements for Nimendra's bridge:

- `GET /healthz` returns a JSON object with `service: "mock-erp"`, health,
  active tool count, and active tool names.
- `POST /reset` restores the seeded fixture state and clears the in-memory
  request log.
