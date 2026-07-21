# Configuration Management (`internal/config/`)

The `internal/config/` package manages environment-specific settings and the cache-adapter selection. Durable database connections and migrations live in `internal/storage/`.

## Files

### `config.go`

This is the core of the configuration package. It defines the `Config` struct, which contains all parameters required by the application, from server settings to LLM provider details.

*   **`Load()`**: The primary function that:
    *   Uses `godotenv` to load `.env` files (supporting `.env.local`, `.env.development`, etc.).
    *   Auto-detects the backend root directory to resolve relative paths for registries and datasets.
    *   Parses environment variables into the `Config` struct with sensible defaults.
*   **Settings include**:
    *   Server host/port and API base path.
    *   JWT secrets and token TTL.
    *   First-administrator bootstrap and public-registration policy.
    *   LLM configuration (Ollama and Gemini).
    *   Semantic search parameters (URLs, thresholds, and fallback modes).
    *   Paths for tool and rule registries.

### `redis.go`

Handles the initialization of the Redis cache adapter.

*   **Current State**: It currently selects an in-memory policy cache and never logs the credential-bearing Redis URL.
*   **Design**: Provides the infrastructure to integrate Redis for distributed caching and session management.

## Key Functions & Responsibilities

*   **Path Resolution**: The package ensures that paths for datasets and configuration files are correctly resolved regardless of whether the app is run from the root or the `backend/` directory.
*   **Typed Access**: Provides typed access (ints, bools, durations) to environment variables, reducing parsing logic in other parts of the system.
*   **Fail-closed Production Validation**: Requires strong JWT/bootstrap secrets, disables public registration and mock MCP mode, and keeps the default HTTP bind address on loopback.
