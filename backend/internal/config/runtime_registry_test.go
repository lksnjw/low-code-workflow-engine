package config

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExperimentReadsOnlyFrozenEvalRegistry(t *testing.T) {
	raw := readExperimentMain(t)
	for _, expected := range []string{
		`filepath.Join("configs", "registries", "all_tools_master_registry.json")`,
		`filepath.Join("configs", "registries", "all_rules_master_registry.json")`,
	} {
		if !bytes.Contains(raw, []byte(expected)) {
			t.Fatalf("run-experiment is not pinned to %s", expected)
		}
	}
	if bytes.Contains(raw, []byte(`configs/runtime`)) {
		t.Fatal("run-experiment references the runtime registry")
	}
}

func TestExperimentIgnoresRuntimeRegistryEnvVars(t *testing.T) {
	raw := readExperimentMain(t)
	for _, variable := range []string{"TOOL_REGISTRY_PATH", "RULE_REGISTRY_PATH", "RUNTIME_REGISTRY_SEED"} {
		if bytes.Contains(raw, []byte(variable)) {
			t.Fatalf("run-experiment reads runtime registry variable %s", variable)
		}
	}
}

func TestServerReadsRuntimeRegistryOnly(t *testing.T) {
	t.Setenv("TOOL_REGISTRY_PATH", "./configs/runtime/all_tools_master_registry.json")
	t.Setenv("RULE_REGISTRY_PATH", "./configs/runtime/all_rules_master_registry.json")
	t.Setenv("RUNTIME_REGISTRY_SEED", "copy")
	cfg := Load()
	if !isRuntimeRegistryPath(cfg.ToolRegistryPath) || !isRuntimeRegistryPath(cfg.RuleRegistryPath) {
		t.Fatalf("server paths are not runtime-only: tools=%s rules=%s", cfg.ToolRegistryPath, cfg.RuleRegistryPath)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("runtime registry configuration rejected: %v", err)
	}

	cfg.ToolRegistryPath = filepath.Join("configs", "registries", "all_tools_master_registry.json")
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "configs/runtime") {
		t.Fatalf("server accepted frozen tool registry path: %v", err)
	}
}

func TestSeedCopyProducesByteIdenticalRuntimeCopy(t *testing.T) {
	cfg := runtimeRegistryTestConfig(t, "copy")
	toolSource := []byte("[\r\n  {\"tool_id\":\"byte-identical\"}\r\n]\r\n")
	ruleSource := []byte("[\n  {\"rule_id\":\"byte-identical\"}\n]\n")
	writeTestFile(t, cfg.FrozenToolRegistryPath, toolSource)
	writeTestFile(t, cfg.FrozenRuleRegistryPath, ruleSource)

	if _, err := EnsureRuntimeRegistries(cfg); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(toolSource, readTestFile(t, cfg.ToolRegistryPath)) {
		t.Fatal("runtime tool seed is not byte-identical to the frozen source")
	}
	if !bytes.Equal(ruleSource, readTestFile(t, cfg.RuleRegistryPath)) {
		t.Fatal("runtime rule seed is not byte-identical to the frozen source")
	}
}

func TestSeedEmptyProducesValidEmptyRuntimeRegistry(t *testing.T) {
	cfg := runtimeRegistryTestConfig(t, "empty")
	if _, err := EnsureRuntimeRegistries(cfg); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{cfg.ToolRegistryPath, cfg.RuleRegistryPath} {
		var values []json.RawMessage
		if err := json.Unmarshal(readTestFile(t, path), &values); err != nil {
			t.Fatalf("%s is not valid JSON: %v", path, err)
		}
		if values == nil || len(values) != 0 {
			t.Fatalf("%s is not a valid empty registry: %#v", path, values)
		}
	}
}

func TestSeedNeverOverwritesExistingRuntimeFiles(t *testing.T) {
	cfg := runtimeRegistryTestConfig(t, "copy")
	writeTestFile(t, cfg.FrozenToolRegistryPath, []byte("[{\"tool_id\":\"frozen\"}]\n"))
	writeTestFile(t, cfg.FrozenRuleRegistryPath, []byte("[{\"rule_id\":\"frozen\"}]\n"))
	existingTools := []byte("[{\"tool_id\":\"runtime-existing\"}]\n")
	existingRules := []byte("[{\"rule_id\":\"runtime-existing\"}]\n")
	writeTestFile(t, cfg.ToolRegistryPath, existingTools)
	writeTestFile(t, cfg.RuleRegistryPath, existingRules)

	if _, err := EnsureRuntimeRegistries(cfg); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(existingTools, readTestFile(t, cfg.ToolRegistryPath)) ||
		!bytes.Equal(existingRules, readTestFile(t, cfg.RuleRegistryPath)) {
		t.Fatal("first-boot seed overwrote an existing runtime registry")
	}
}

func readExperimentMain(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "cmd", "run-experiment", "main.go"))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func runtimeRegistryTestConfig(t *testing.T, seed string) Config {
	t.Helper()
	root := t.TempDir()
	return Config{
		ToolRegistryPath:       filepath.Join(root, "configs", "runtime", "all_tools_master_registry.json"),
		RuleRegistryPath:       filepath.Join(root, "configs", "runtime", "all_rules_master_registry.json"),
		FrozenToolRegistryPath: filepath.Join(root, "frozen", "all_tools_master_registry.json"),
		FrozenRuleRegistryPath: filepath.Join(root, "frozen", "all_rules_master_registry.json"),
		RuntimeRegistrySeed:    seed,
	}
}

func writeTestFile(t *testing.T, path string, raw []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func readTestFile(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
