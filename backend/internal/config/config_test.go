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
