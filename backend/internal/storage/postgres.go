package storage

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	defaultStateKey                  = "default"
	migrationAdvisoryLockKey   int64 = 741825903
	runtimeWriterLockNamespace int32 = 741825904
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

type PostgresStore struct {
	pool       *pgxpool.Pool
	writerConn *pgxpool.Conn
	writerMu   sync.Mutex
	closeOnce  sync.Once
	stateKey   string
}

func OpenPostgres(ctx context.Context, databaseURL string) (*PostgresStore, error) {
	return openPostgres(ctx, databaseURL, defaultStateKey)
}

func openPostgres(ctx context.Context, databaseURL, stateKey string) (*PostgresStore, error) {
	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		// Parse errors can echo the input DSN, which may contain credentials.
		return nil, fmt.Errorf("invalid DATABASE_URL for PostgreSQL storage")
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("create PostgreSQL pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect to PostgreSQL at %s:%d: connection failed", poolConfig.ConnConfig.Host, poolConfig.ConnConfig.Port)
	}
	if err := runMigrations(ctx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	writerConn, err := pool.Acquire(ctx)
	if err != nil {
		pool.Close()
		return nil, fmt.Errorf("reserve PostgreSQL writer connection: %w", err)
	}
	var ownsWriterLock bool
	if err := writerConn.QueryRow(ctx,
		`SELECT pg_try_advisory_lock($1::integer, hashtext($2))`,
		runtimeWriterLockNamespace, stateKey,
	).Scan(&ownsWriterLock); err != nil {
		writerConn.Release()
		pool.Close()
		return nil, fmt.Errorf("acquire PostgreSQL runtime writer lock: %w", err)
	}
	if !ownsWriterLock {
		writerConn.Release()
		pool.Close()
		return nil, fmt.Errorf("another backend writer already owns PostgreSQL runtime state %q", stateKey)
	}
	return &PostgresStore{pool: pool, writerConn: writerConn, stateKey: stateKey}, nil
}

func (s *PostgresStore) Load(ctx context.Context) ([]byte, bool, error) {
	s.writerMu.Lock()
	defer s.writerMu.Unlock()
	if s.writerConn == nil {
		return nil, false, fmt.Errorf("PostgreSQL state store is closed")
	}
	var payload []byte
	err := s.writerConn.QueryRow(ctx, `SELECT payload FROM runtime_state WHERE state_key = $1`, s.stateKey).Scan(&payload)
	if err == pgx.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("load persisted runtime state: %w", err)
	}
	return append([]byte(nil), payload...), true, nil
}

func (s *PostgresStore) Save(ctx context.Context, payload []byte) error {
	s.writerMu.Lock()
	defer s.writerMu.Unlock()
	if s.writerConn == nil {
		return fmt.Errorf("PostgreSQL state store is closed")
	}
	_, err := s.writerConn.Exec(ctx, `
		INSERT INTO runtime_state (state_key, payload, updated_at)
		VALUES ($1, $2, NOW())
		ON CONFLICT (state_key) DO UPDATE
		SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
		s.stateKey, payload,
	)
	if err != nil {
		return fmt.Errorf("save persisted runtime state: %w", err)
	}
	return nil
}

func (s *PostgresStore) Probe(ctx context.Context) error {
	s.writerMu.Lock()
	defer s.writerMu.Unlock()
	if s.writerConn == nil {
		return fmt.Errorf("PostgreSQL state store is closed")
	}
	var one int
	if err := s.writerConn.QueryRow(ctx, `SELECT 1`).Scan(&one); err != nil {
		return fmt.Errorf("probe PostgreSQL persistence: %w", err)
	}
	return nil
}

func (s *PostgresStore) Close() {
	if s == nil {
		return
	}
	s.closeOnce.Do(func() {
		s.writerMu.Lock()
		if s.writerConn != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_, _ = s.writerConn.Exec(ctx,
				`SELECT pg_advisory_unlock($1::integer, hashtext($2))`,
				runtimeWriterLockNamespace, s.stateKey,
			)
			cancel()
			s.writerConn.Release()
			s.writerConn = nil
		}
		s.writerMu.Unlock()
		if s.pool != nil {
			s.pool.Close()
		}
	})
}

func runMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	if err := initializeMigrationTable(ctx, pool); err != nil {
		return err
	}

	entries, err := fs.ReadDir(migrationFiles, "migrations")
	if err != nil {
		return fmt.Errorf("read embedded migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".up.sql") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		versionText := strings.SplitN(filepath.Base(name), "_", 2)[0]
		version, parseErr := strconv.ParseInt(versionText, 10, 64)
		if parseErr != nil {
			return fmt.Errorf("invalid migration filename %q: %w", name, parseErr)
		}
		if err := applyMigration(ctx, pool, version, name); err != nil {
			return err
		}
	}
	return nil
}

func initializeMigrationTable(ctx context.Context, pool *pgxpool.Pool) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin migration initialization: %w", err)
	}
	defer tx.Rollback(ctx) // no-op after commit
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, migrationAdvisoryLockKey); err != nil {
		return fmt.Errorf("lock migration initialization: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version BIGINT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`); err != nil {
		return fmt.Errorf("initialize migration table: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit migration initialization: %w", err)
	}
	return nil
}

func applyMigration(ctx context.Context, pool *pgxpool.Pool, version int64, name string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin migration %d: %w", version, err)
	}
	defer tx.Rollback(ctx) // no-op after commit
	// Serialize startup migrations across multiple server replicas.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, migrationAdvisoryLockKey); err != nil {
		return fmt.Errorf("lock migration runner: %w", err)
	}

	var applied bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1)`, version).Scan(&applied); err != nil {
		return fmt.Errorf("check migration %d: %w", version, err)
	}
	if applied {
		return tx.Commit(ctx)
	}

	sqlBytes, err := migrationFiles.ReadFile("migrations/" + name)
	if err != nil {
		return fmt.Errorf("read migration %d: %w", version, err)
	}
	if _, err := tx.Exec(ctx, string(sqlBytes)); err != nil {
		return fmt.Errorf("apply migration %d: %w", version, err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, version); err != nil {
		return fmt.Errorf("record migration %d: %w", version, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit migration %d: %w", version, err)
	}
	return nil
}
