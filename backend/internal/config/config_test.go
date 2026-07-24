package config

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestBaselineBProductionConfigurationRefusesStartup(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	t.Setenv("EXPERIMENT_BASELINE", "B")

	cfg := Load()
	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "requires APP_ENV=experiment") {
		t.Fatalf("expected production Baseline B startup refusal, got %v", err)
	}
}

func TestBaselineBIsEnabledOnlyForExperimentEnvironment(t *testing.T) {
	t.Setenv("APP_ENV", "experiment")
	t.Setenv("EXPERIMENT_BASELINE", "B")

	cfg := Load()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected experiment Baseline B configuration to be valid: %v", err)
	}
	if !cfg.BaselineBEnabled() {
		t.Fatal("expected Baseline B to be enabled")
	}
}

func TestDemoModesAreExplicitAndValidated(t *testing.T) {
	t.Setenv("MCP_MODE", "mock")
	t.Setenv("SEMANTIC_FALLBACK", "lexical")
	t.Setenv("EXPERIMENT_BASELINE", "")

	cfg := Load()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected demo configuration to be valid: %v", err)
	}
	if cfg.MCPMode != "mock" {
		t.Fatalf("MCPMode=%q, want mock", cfg.MCPMode)
	}
	if cfg.SemanticFallback != "lexical" || !cfg.SemanticSearchAllowLexicalFallback {
		t.Fatalf("semantic fallback=%q allowed=%t, want lexical/true", cfg.SemanticFallback, cfg.SemanticSearchAllowLexicalFallback)
	}
}

func TestUnknownDemoModesRefuseStartup(t *testing.T) {
	tests := []struct {
		name string
		cfg  Config
	}{
		{name: "mcp", cfg: Config{MCPMode: "simulate"}},
		{name: "semantic", cfg: Config{SemanticFallback: "always"}},
	}
	for _, item := range tests {
		t.Run(item.name, func(t *testing.T) {
			if err := item.cfg.Validate(); err == nil {
				t.Fatal("expected unsupported demo mode to be rejected")
			}
		})
	}
}

func TestStorageDefaultsToMemory(t *testing.T) {
	t.Setenv("STORAGE_DRIVER", "")
	t.Setenv("STORAGE_ENCRYPTION_KEY", "")
	t.Setenv("EXPERIMENT_BASELINE", "")

	cfg := Load()
	if cfg.StorageDriver != "memory" {
		t.Fatalf("StorageDriver=%q, want memory", cfg.StorageDriver)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("memory configuration should be valid: %v", err)
	}
}

func TestSampleDataSeedingIsExplicitlyOptIn(t *testing.T) {
	t.Setenv("SEED_SAMPLE_DATA", "")
	t.Setenv("SAMPLE_TOOL_SEED_PATH", "")
	t.Setenv("SAMPLE_RULE_SEED_PATH", "")

	cfg := Load()
	if cfg.SeedSampleData {
		t.Fatal("sample data seeding must default to disabled")
	}
	if !strings.Contains(filepath.ToSlash(cfg.SampleToolSeedPath), "configs/seed/sample_tools.json") {
		t.Fatalf("unexpected sample tool seed path %q", cfg.SampleToolSeedPath)
	}
	if !strings.Contains(filepath.ToSlash(cfg.SampleRuleSeedPath), "configs/seed/sample_rules.json") {
		t.Fatalf("unexpected sample rule seed path %q", cfg.SampleRuleSeedPath)
	}
}

func TestEnabledSampleDataSeedingRequiresBothPaths(t *testing.T) {
	cfg := Config{SeedSampleData: true, SampleToolSeedPath: "tools.json"}
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "SAMPLE_RULE_SEED_PATH") {
		t.Fatalf("expected missing sample seed path error, got %v", err)
	}
}

func TestDevelopmentDefaultsAreLocalAndAllowRegistration(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	t.Setenv("APP_HOST", "")
	t.Setenv("ALLOW_PUBLIC_REGISTRATION", "")
	t.Setenv("BOOTSTRAP_ADMIN_EMAIL", "")
	t.Setenv("BOOTSTRAP_ADMIN_PASSWORD", "")
	t.Setenv("EXPERIMENT_BASELINE", "")

	cfg := Load()
	if cfg.Host != "127.0.0.1" {
		t.Fatalf("Host=%q, want loopback default", cfg.Host)
	}
	if !cfg.AllowPublicRegistration {
		t.Fatal("development should allow public registration by default")
	}
}

func TestProductionDefaultsDisablePublicRegistration(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	t.Setenv("ALLOW_PUBLIC_REGISTRATION", "")
	t.Setenv("EXPERIMENT_BASELINE", "")

	cfg := Load()
	if cfg.AllowPublicRegistration {
		t.Fatal("production must disable public registration by default")
	}
}

func TestCORSOriginsDoNotAddDevelopmentOriginsInProduction(t *testing.T) {
	production := Config{Environment: "production", FrontendURL: "https://portal.example.test"}
	if got := production.CORSOrigins(); got != "https://portal.example.test" {
		t.Fatalf("production CORS origins=%q", got)
	}

	development := Config{Environment: "development", FrontendURL: "http://127.0.0.1:5173"}
	got := development.CORSOrigins()
	if got != "http://127.0.0.1:5173,http://localhost:5173" {
		t.Fatalf("development CORS origins=%q", got)
	}
}

func TestPostgresStorageRequiresEncryptionKey(t *testing.T) {
	cfg := Config{StorageDriver: "postgres", DatabaseURL: "postgres://localhost/workflow"}
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "STORAGE_ENCRYPTION_KEY") {
		t.Fatalf("expected encryption key requirement, got %v", err)
	}
}

func TestUnknownStorageDriverRefusesStartup(t *testing.T) {
	cfg := Config{StorageDriver: "file"}
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "unsupported STORAGE_DRIVER") {
		t.Fatalf("expected unsupported storage driver error, got %v", err)
	}
}

func TestProductionSafetyGuards(t *testing.T) {
	const strongJWT = "jwt-secret-0123456789abcdef-0123456789abcdef"
	tests := []struct {
		name string
		cfg  Config
		want string
	}{
		{
			name: "default JWT secret",
			cfg:  Config{Environment: "production", JWTSecret: "local-development-secret-change-me"},
			want: "JWT_SECRET",
		},
		{
			name: "short JWT secret",
			cfg:  Config{Environment: "production", JWTSecret: "too-short"},
			want: "JWT_SECRET",
		},
		{
			name: "public registration",
			cfg:  Config{Environment: "production", JWTSecret: strongJWT, AllowPublicRegistration: true},
			want: "ALLOW_PUBLIC_REGISTRATION",
		},
		{
			name: "mock MCP",
			cfg:  Config{Environment: "production", JWTSecret: strongJWT, MCPMode: "mock"},
			want: "MCP_MODE=mock",
		},
	}
	for _, item := range tests {
		t.Run(item.name, func(t *testing.T) {
			err := item.cfg.Validate()
			if err == nil || !strings.Contains(err.Error(), item.want) {
				t.Fatalf("expected production guard containing %q, got %v", item.want, err)
			}
		})
	}
}

func TestValidProductionSecurityConfiguration(t *testing.T) {
	cfg := Config{
		Environment:          "production",
		JWTSecret:            "jwt-secret-0123456789abcdef-0123456789abcdef",
		MCPMode:              "remote",
		StorageDriver:        "postgres",
		DatabaseURL:          "postgres://database.example.test/workflow",
		StorageEncryptionKey: "0123456789abcdef0123456789abcdef",
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("valid production configuration rejected: %v", err)
	}
}

func TestProductionRequiresDurablePostgresStorage(t *testing.T) {
	cfg := Config{
		Environment:   "production",
		JWTSecret:     "jwt-secret-0123456789abcdef-0123456789abcdef",
		MCPMode:       "remote",
		StorageDriver: "memory",
	}
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "STORAGE_DRIVER") {
		t.Fatalf("expected production memory storage refusal, got %v", err)
	}
}
