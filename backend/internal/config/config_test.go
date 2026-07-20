package config

import (
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
