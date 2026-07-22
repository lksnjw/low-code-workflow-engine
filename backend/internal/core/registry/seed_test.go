package registry

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.uber.org/zap"
)

func TestSeedEmptyRegistriesPersistsPublishesAndIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	toolPath := filepath.Join(dir, "tools.json")
	rulePath := filepath.Join(dir, "rules.json")
	toolSeedPath := filepath.Join(dir, "sample-tools.json")
	ruleSeedPath := filepath.Join(dir, "sample-rules.json")
	writeSeedFixture(t, toolPath, []Tool{})
	writeSeedFixture(t, rulePath, []Rule{})
	seedTools := []Tool{seedTestTool("SAMPLE-001", "sample.lookup"), seedTestTool("SAMPLE-002", "sample.submit")}
	seedRules := []Rule{seedTestRule("SAMPLE-RULE-001")}
	writeSeedFixture(t, toolSeedPath, seedTools)
	writeSeedFixture(t, ruleSeedPath, seedRules)

	bundle, err := LoadBundle(toolPath, rulePath, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	manager := NewManager(bundle, toolPath, rulePath)
	upserted := []string{}
	manager.SetToolUpsert(func(tool Tool) { upserted = append(upserted, tool.ToolID) })
	oldHash := manager.Hash()

	result, err := manager.SeedEmptyRegistries(toolSeedPath, ruleSeedPath)
	if err != nil {
		t.Fatalf("seed empty registries: %v", err)
	}
	if !result.Seeded || result.ToolsAdded != 2 || result.RulesAdded != 1 {
		t.Fatalf("unexpected seed result: %+v", result)
	}
	if result.OldHash != oldHash || result.NewHash == oldHash || manager.Hash() != result.NewHash {
		t.Fatalf("registry hash was not updated consistently: result=%+v live=%s", result, manager.Hash())
	}
	if len(manager.Tools()) != 2 || len(manager.Rules()) != 1 {
		t.Fatalf("seed was not atomically published: tools=%d rules=%d", len(manager.Tools()), len(manager.Rules()))
	}
	if strings.Join(upserted, ",") != "SAMPLE-001,SAMPLE-002" {
		t.Fatalf("tool upsert callback values = %v", upserted)
	}
	assertRegistryLength[Tool](t, toolPath, 2)
	assertRegistryLength[Rule](t, rulePath, 1)

	second, err := manager.SeedEmptyRegistries(toolSeedPath, ruleSeedPath)
	if err != nil {
		t.Fatalf("repeat seed: %v", err)
	}
	if second.Seeded || second.OldHash != result.NewHash || second.NewHash != result.NewHash {
		t.Fatalf("repeat seed was not a no-op: %+v", second)
	}
	if len(upserted) != 2 {
		t.Fatalf("repeat seed invoked callbacks: %v", upserted)
	}
}

func TestSeedEmptyRegistriesDoesNotMixSamplesIntoPopulatedRegistry(t *testing.T) {
	dir := t.TempDir()
	toolPath := filepath.Join(dir, "tools.json")
	rulePath := filepath.Join(dir, "rules.json")
	toolSeedPath := filepath.Join(dir, "sample-tools.json")
	ruleSeedPath := filepath.Join(dir, "sample-rules.json")
	writeSeedFixture(t, toolPath, []Tool{seedTestTool("REAL-001", "real.lookup")})
	writeSeedFixture(t, rulePath, []Rule{})
	writeSeedFixture(t, toolSeedPath, []Tool{seedTestTool("SAMPLE-001", "sample.lookup")})
	writeSeedFixture(t, ruleSeedPath, []Rule{seedTestRule("SAMPLE-RULE-001")})

	bundle, err := LoadBundle(toolPath, rulePath, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	manager := NewManager(bundle, toolPath, rulePath)
	before := manager.Hash()
	result, err := manager.SeedEmptyRegistries(toolSeedPath, ruleSeedPath)
	if err != nil {
		t.Fatalf("evaluate seed on populated registry: %v", err)
	}
	if result.Seeded || manager.Hash() != before || len(manager.Tools()) != 1 || len(manager.Rules()) != 0 {
		t.Fatalf("populated registry was changed: result=%+v", result)
	}
	assertRegistryLength[Tool](t, toolPath, 1)
	assertRegistryLength[Rule](t, rulePath, 0)
}

func TestSeedEmptyRegistriesStrictlyRejectsUnknownFieldsBeforeMutation(t *testing.T) {
	dir := t.TempDir()
	toolPath := filepath.Join(dir, "tools.json")
	rulePath := filepath.Join(dir, "rules.json")
	toolSeedPath := filepath.Join(dir, "sample-tools.json")
	ruleSeedPath := filepath.Join(dir, "sample-rules.json")
	writeSeedFixture(t, toolPath, []Tool{})
	writeSeedFixture(t, rulePath, []Rule{})
	if err := os.WriteFile(toolSeedPath, []byte(`[{"tool_id":"BAD","unexpected":true}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	writeSeedFixture(t, ruleSeedPath, []Rule{seedTestRule("SAMPLE-RULE-001")})

	bundle, err := LoadBundle(toolPath, rulePath, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	manager := NewManager(bundle, toolPath, rulePath)
	before := manager.Hash()
	_, err = manager.SeedEmptyRegistries(toolSeedPath, ruleSeedPath)
	if err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("expected strict seed schema rejection, got %v", err)
	}
	if manager.Hash() != before || len(manager.Tools()) != 0 || len(manager.Rules()) != 0 {
		t.Fatal("invalid seed changed the live registries")
	}
	assertRegistryLength[Tool](t, toolPath, 0)
	assertRegistryLength[Rule](t, rulePath, 0)
}

func TestBundledSampleSeedsAreStrictAndComplete(t *testing.T) {
	root := filepath.Join("..", "..", "..", "configs", "seed")
	tools, err := loadToolSeed(filepath.Join(root, "sample_tools.json"))
	if err != nil {
		t.Fatalf("load bundled sample tools: %v", err)
	}
	rules, err := loadRuleSeed(filepath.Join(root, "sample_rules.json"))
	if err != nil {
		t.Fatalf("load bundled sample rules: %v", err)
	}
	if len(tools) != 5 || len(rules) != 5 {
		t.Fatalf("bundled seed counts tools=%d rules=%d, want 5 each", len(tools), len(rules))
	}
	wantedTypes := map[string]bool{
		"rbac": false, "amount_threshold": false, "parameter_required": false,
		"risk_escalation": false, "separation_of_duties": false,
	}
	for _, rule := range rules {
		if _, expected := wantedTypes[rule.RuleType]; expected {
			wantedTypes[rule.RuleType] = true
		}
	}
	for ruleType, found := range wantedTypes {
		if !found {
			t.Fatalf("bundled sample rules are missing %s", ruleType)
		}
	}
}

func seedTestTool(id, name string) Tool {
	return Tool{
		ToolID: id, Name: name, DisplayName: name, Module: "sample",
		Status: "active_mcp_schema_present", Description: "Sample tool.",
		HTTPMethod: "POST", MCPToolName: name,
		InputSchema: map[string]interface{}{"type": "object"},
	}
}

func seedTestRule(id string) Rule {
	return Rule{
		RuleID: id, RuleName: id, RuleType: "rbac", Domain: "sample",
		Description: "Sample rule.", Condition: RuleCondition{Type: "role_permission", Operator: "=="},
		EnforcementAction: "block", Severity: "high", ValidatorMessage: "Blocked.", Enabled: true,
	}
}

func writeSeedFixture(t *testing.T, path string, value interface{}) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func assertRegistryLength[T any](t *testing.T, path string, expected int) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var items []T
	if err := json.Unmarshal(raw, &items); err != nil {
		t.Fatal(err)
	}
	if len(items) != expected {
		t.Fatalf("%s contains %d entries, want %d", path, len(items), expected)
	}
}
