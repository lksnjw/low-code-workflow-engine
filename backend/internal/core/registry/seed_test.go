package registry

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.uber.org/zap"
)

func TestSeedNotLoadedIntoEvaluatedRegistry(t *testing.T) {
	dir := t.TempDir()
	toolPath := filepath.Join(dir, "all_tools_master_registry.json")
	rulePath := filepath.Join(dir, "all_rules_master_registry.json")
	toolSeedPath := filepath.Join(dir, "sample-tools.json")
	ruleSeedPath := filepath.Join(dir, "sample-rules.json")
	writeSeedFixture(t, toolPath, []Tool{seedTestTool("REAL-001", "real.lookup")})
	writeSeedFixture(t, rulePath, []Rule{seedTestRule("REAL-RULE-001")})
	writeSeedFixture(t, toolSeedPath, []Tool{seedTestTool("SAMPLE-001", "sample.lookup")})
	writeSeedFixture(t, ruleSeedPath, []Rule{seedTestRule("SAMPLE-RULE-001")})

	bundle, err := LoadBundle(toolPath, rulePath, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	manager := NewManager(bundle, toolPath, rulePath)
	beforeHash := manager.Hash()
	beforeTools, err := os.ReadFile(toolPath)
	if err != nil {
		t.Fatal(err)
	}
	beforeRules, err := os.ReadFile(rulePath)
	if err != nil {
		t.Fatal(err)
	}

	preview, err := manager.LoadSeedPreview(toolSeedPath, ruleSeedPath)
	if err != nil {
		t.Fatalf("load isolated seed preview: %v", err)
	}
	if len(preview.Tools) != 1 || len(preview.Rules) != 1 || preview.EvaluatedRegistryHash != beforeHash {
		t.Fatalf("unexpected preview: %+v", preview)
	}
	afterTools, _ := os.ReadFile(toolPath)
	afterRules, _ := os.ReadFile(rulePath)
	if manager.Hash() != beforeHash || !bytes.Equal(beforeTools, afterTools) || !bytes.Equal(beforeRules, afterRules) {
		t.Fatal("seed preview changed the evaluated registry or a master registry file")
	}
	if len(manager.Tools()) != 1 || manager.Tools()[0].ToolID != "REAL-001" ||
		len(manager.Rules()) != 1 || manager.Rules()[0].RuleID != "REAL-RULE-001" {
		t.Fatal("sample definitions reached the evaluated registry")
	}
}

func TestSeedPreviewStrictlyRejectsUnknownFieldsBeforeMutation(t *testing.T) {
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
	_, err = manager.LoadSeedPreview(toolSeedPath, ruleSeedPath)
	if err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("expected strict seed schema rejection, got %v", err)
	}
	if manager.Hash() != before || len(manager.Tools()) != 0 || len(manager.Rules()) != 0 {
		t.Fatal("invalid seed changed the live registries")
	}
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
