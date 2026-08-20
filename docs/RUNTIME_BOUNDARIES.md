# Runtime boundaries

This document states the operational limits of the current runtime. It is a support contract, not a roadmap.

## Execution lifecycle

- Workflow runs are synchronous. `POST /api/workflows/:id/run` validates, creates a running record, invokes the runner in the request context, stores the terminal result, and then returns the response. There is no background job queue or worker handoff.
- Cancellation is unavailable. `POST /api/executions/:id/cancel` returns HTTP 501 while execution remains synchronous.
- Live execution streaming is unavailable in the browser. The backend exposes an authenticated WebSocket handshake route, but the frontend has no WebSocket or EventSource consumer. Execution screens read stored logs and timelines after or between HTTP requests; they do not receive live step events.
- A server interruption can leave a running record without a terminal update. Startup reconciliation marks orphaned running executions failed; it does not resume them.

## Persistence and durability

- `STORAGE_DRIVER=postgres` is the durable mode. The repository restores and synchronously saves an encrypted, versioned whole-state snapshot through PostgreSQL.
- `STORAGE_DRIVER=memory` is process-local and not durable. Workflows, executions, chats, audits, settings, and other runtime state are lost when the process exits.
- Production configuration rejects memory storage. Operators must supply PostgreSQL configuration and the storage encryption key required by the server configuration checks.

## ERP boundary

- The standalone mock ERP is a development/demo dependency, not a production connector. Its own process refuses `APP_ENV=production`.
- The backend also inspects the configured MCP endpoint and refuses startup in production when it identifies the standalone mock ERP. A successful local mock-ERP run is evidence of the MCP contract path, not evidence of compatibility with a real ERP.

## Chat-to-workflow boundary

- Chat generation returns candidate YAML and validation information. That YAML is not yet a stored workflow and cannot be treated as a deployed executable artifact.
- “Pass to canvas” transfers the selected YAML into the builder. The user must still deploy it, which creates or updates a workflow and publishes it through the normal validated workflow APIs, before running it.
- A candidate can remain in persisted chat history, but it remains a chat artifact rather than a workflow entity. Only deployment creates the workflow record that can enter workflow execution history.

## Operator summary

| Capability | Current boundary |
|---|---|
| Run dispatch | Synchronous HTTP request |
| Cancel | Unavailable; HTTP 501 |
| Live browser stream | Unavailable |
| PostgreSQL storage | Durable encrypted snapshot |
| Memory storage | Volatile process state |
| Mock ERP in production | Refused by mock ERP and backend detection |
| Chat candidate YAML | Candidate only until builder deployment |
