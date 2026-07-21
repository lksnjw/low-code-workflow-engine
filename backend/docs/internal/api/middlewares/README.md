# API Middlewares (`internal/api/middlewares/`)

Middlewares are functions that execute during the HTTP request-response cycle, allowing for centralized handling of authentication, logging, and authorization.

## Middleware Components

### `auth.go`

Provides JWT-based authentication for protected routes.

*   **Logic**: Checks for a signed JWT in the `Authorization: Bearer` header. The `token` query parameter is accepted only for the `/ws/*` WebSocket handshake because browser WebSocket APIs cannot set an Authorization header.
*   **No Authentication Bypass**: Development and production use the same signed-token validation path.
*   **Context Injection**: Successfully validated tokens result in the `userID` being stored in the `fiber.Ctx.Locals`, making it available to downstream handlers.

### `logger.go`

A structured request logger using `uber-go/zap`.

*   **Functionality**: Records every incoming HTTP request with its method, path, response status code, processing latency, and client IP address.
*   **Purpose**: Essential for monitoring API health, performance tracking, and debugging.

### `rate_limit.go`

Provides a process-local fixed-window limiter keyed by client IP and request
path. The authentication mutation routes allow ten attempts per path per minute
and return the standard API failure envelope with HTTP `429` and a
`Retry-After` header after that allowance is exhausted.

### `rbac.go`

Implements Role-Based Access Control (RBAC).

*   **Logic**: A simple middleware factory (`RequirePermission`) that checks if the authenticated user possesses a specific permission string.
*   **Interactions**: It calls a provided `getPermissions` function (usually resolved via the handler) to retrieve the current user's permission set from the store.

## Usage in Routes

Middlewares are applied in `internal/api/routes/routes.go`:

```go
// Global middleware
app.Use(middlewares.RequestLogger(zapLogger))

// Group-level middleware
protected := api.Group("", middlewares.Auth(cfg.JWTSecret))
```
