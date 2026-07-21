package storage

import (
	"context"
	"fmt"
	"strings"
)

// StateStore is the durable boundary used by the current map-backed runtime.
// It stores an opaque encrypted payload so persistence can be introduced
// without exposing secrets or changing every handler in one migration.
type StateStore interface {
	Load(context.Context) ([]byte, bool, error)
	Save(context.Context, []byte) error
	Probe(context.Context) error
	Close()
}

// Open creates the configured storage backend. Memory mode is represented by
// a nil StateStore because process-local stores do not need persistence hooks.
func Open(ctx context.Context, driver, databaseURL string) (StateStore, error) {
	switch strings.ToLower(strings.TrimSpace(driver)) {
	case "", "memory":
		return nil, nil
	case "postgres":
		if strings.TrimSpace(databaseURL) == "" {
			return nil, fmt.Errorf("DATABASE_URL is required when STORAGE_DRIVER=postgres")
		}
		return OpenPostgres(ctx, databaseURL)
	default:
		return nil, fmt.Errorf("unsupported STORAGE_DRIVER %q (allowed values: memory or postgres)", driver)
	}
}
