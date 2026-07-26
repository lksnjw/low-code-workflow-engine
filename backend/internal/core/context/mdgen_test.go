package context

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"go.uber.org/zap"
)

func TestGenerationIsDeterministicByteIdentical(t *testing.T) {
	input := renderTestInput()
	first, err := Render(input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Render(input)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal([]byte(first.Markdown), []byte(second.Markdown)) {
		t.Fatal("identical typed registry input produced different Markdown bytes")
	}
}

func TestFrontMatterHashMatchesActiveRegistry(t *testing.T) {
	service, manager, _, _ := contextTestService(t, []registry.Tool{contextTestTool("TOOL-001", "finance.invoice.create", "finance")}, []registry.Rule{contextTestRule("RULE-001", "parameter_required", "exists")})
	document, err := service.Regenerate()
	if err != nil {
		t.Fatal(err)
	}
	if document.FrontMatter.RegistryHash != manager.Hash() {
		t.Fatalf("front matter hash=%s active=%s", document.FrontMatter.RegistryHash, manager.Hash())
	}
}

func TestStaleContextRegeneratedBeforeUse(t *testing.T) {
	service, manager, _, _ := contextTestService(t, []registry.Tool{contextTestTool("TOOL-001", "finance.invoice.create", "finance")}, nil)
	first, err := service.Regenerate()
	if err != nil {
		t.Fatal(err)
	}
	added := contextTestTool("TOOL-002", "finance.invoice.cancel", "finance")
	raw, _ := json.Marshal(added)
	if _, err := manager.AddTool(raw); err != nil {
		t.Fatal(err)
	}
	stale, err := service.Current()
	if err != nil {
		t.Fatal(err)
	}
	if !stale.Stale || stale.FrontMatter.RegistryHash != first.FrontMatter.RegistryHash {
		t.Fatalf("stale context was not detectable: %+v", stale.FrontMatter)
	}
	promptContext, err := service.PromptContext([]string{"finance"})
	if err != nil {
		t.Fatal(err)
	}
	current, err := service.Current()
	if err != nil {
		t.Fatal(err)
	}
	if current.Stale || current.FrontMatter.RegistryHash != manager.Hash() || !strings.Contains(promptContext, manager.Hash()) {
		t.Fatalf("stale context was sent or not regenerated: stale=%v front=%s active=%s", current.Stale, current.FrontMatter.RegistryHash, manager.Hash())
	}
}

func TestRegenerationFailureRollsBackRegistryMutation(t *testing.T) {
	service, manager, toolPath, _ := contextTestService(t, []registry.Tool{contextTestTool("TOOL-001", "finance.invoice.create", "finance")}, nil)
	beforeDocument, err := service.Regenerate()
	if err != nil {
		t.Fatal(err)
	}
	beforeRegistry := readContextTestFile(t, toolPath)
	beforeHash := manager.Hash()
	realWriter := service.writeFile
	service.writeFile = func(path string, raw []byte) error {
		if filepath.Base(path) == "registry_context.md" {
			return errors.New("injected context write failure")
		}
		return realWriter(path, raw)
	}
	added := contextTestTool("TOOL-002", "finance.invoice.cancel", "finance")
	raw, _ := json.Marshal(added)
	if _, err := service.AddTool(raw); err == nil || !strings.Contains(err.Error(), "rolled back") {
		t.Fatalf("mutation did not fail with rollback evidence: %v", err)
	}
	if manager.Hash() != beforeHash || !bytes.Equal(beforeRegistry, readContextTestFile(t, toolPath)) {
		t.Fatal("registry file or live snapshot changed after context regeneration failure")
	}
	afterDocument, err := service.Current()
	if err != nil {
		t.Fatal(err)
	}
	if afterDocument.FrontMatter.RegistryHash != beforeDocument.FrontMatter.RegistryHash || afterDocument.Stale {
		t.Fatal("context and restored registry no longer match")
	}
}

func TestRegistryCRUDRegeneratesContext(t *testing.T) {
	service, manager, _, _ := contextTestService(t, []registry.Tool{contextTestTool("TOOL-001", "finance.invoice.create", "finance")}, nil)
	before, err := service.Regenerate()
	if err != nil {
		t.Fatal(err)
	}
	added := contextTestTool("TOOL-002", "finance.invoice.cancel", "finance")
	raw, _ := json.Marshal(added)
	if _, err := service.AddTool(raw); err != nil {
		t.Fatal(err)
	}
	after, err := service.Current()
	if err != nil {
		t.Fatal(err)
	}
	if after.FrontMatter.RegistryHash == before.FrontMatter.RegistryHash || after.FrontMatter.RegistryHash != manager.Hash() {
		t.Fatalf("CRUD context hash was not regenerated: before=%s after=%s active=%s", before.FrontMatter.RegistryHash, after.FrontMatter.RegistryHash, manager.Hash())
	}
}

func TestSizeCapDegradesByDomainNotByTruncation(t *testing.T) {
	tools := []registry.Tool{}
	for index := 0; index < 2; index++ {
		alpha := contextTestTool(fmt.Sprintf("ALPHA-%d", index), fmt.Sprintf("alpha.record.action%d", index), "alpha")
		alpha.Description = strings.Repeat("alpha detail ", 100)
		alpha.PromptUsageGuidance = "ALPHA-END-" + fmt.Sprint(index)
		tools = append(tools, alpha)
		beta := contextTestTool(fmt.Sprintf("BETA-%d", index), fmt.Sprintf("beta.record.action%d", index), "beta")
		beta.Description = strings.Repeat("beta detail ", 100)
		beta.PromptUsageGuidance = "BETA-END-" + fmt.Sprint(index)
		tools = append(tools, beta)
	}
	input := renderTestInput()
	input.Tools = tools
	input.Rules = nil
	input.SizeCapBytes = 6200
	document, err := Render(input)
	if err != nil {
		t.Fatal(err)
	}
	if document.SizeBytes > input.SizeCapBytes {
		t.Fatalf("size=%d cap=%d", document.SizeBytes, input.SizeCapBytes)
	}
	alphaFull := strings.Contains(document.Body, "### alpha\n") && strings.Contains(document.Body, "ALPHA-END-1")
	betaFull := strings.Contains(document.Body, "### beta\n") && strings.Contains(document.Body, "BETA-END-1")
	alphaNames := strings.Contains(document.Body, "### alpha (name-only)")
	betaNames := strings.Contains(document.Body, "### beta (name-only)")
	if !(alphaFull && betaNames || betaFull && alphaNames) {
		t.Fatalf("context did not degrade as whole domains\n%s", document.Body)
	}
	if strings.Contains(document.Body, "ALPHA-END-0") != strings.Contains(document.Body, "ALPHA-END-1") ||
		strings.Contains(document.Body, "BETA-END-0") != strings.Contains(document.Body, "BETA-END-1") {
		t.Fatal("domain detail was truncated mid-record")
	}
}

func TestEveryActiveToolAppearsExactlyOnce(t *testing.T) {
	input := renderTestInput()
	input.Tools = []registry.Tool{
		contextTestTool("TOOL-001", "finance.invoice.create", "finance"),
		contextTestTool("TOOL-002", "hr.leave.approve", "hr"),
	}
	input.Rules = nil
	document, err := Render(input)
	if err != nil {
		t.Fatal(err)
	}
	catalogue := markdownSection(document.Body, "## 2. TOOL CATALOGUE")
	for _, tool := range input.Tools {
		if count := strings.Count(catalogue, "#### `"+tool.Name+"`"); count != 1 {
			t.Fatalf("active tool %s catalogue count=%d", tool.Name, count)
		}
	}
}

func TestInactiveToolsExcluded(t *testing.T) {
	active := contextTestTool("TOOL-001", "finance.invoice.create", "finance")
	inactive := contextTestTool("TOOL-002", "finance.invoice.future", "finance")
	inactive.Status = "recommended_future_capability"
	input := renderTestInput()
	input.Tools = []registry.Tool{active, inactive}
	input.Rules = nil
	document, err := Render(input)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(document.Body, active.Name) || strings.Contains(document.Body, inactive.Name) {
		t.Fatalf("inactive tool filtering failed\n%s", document.Body)
	}
}

func TestEveryActiveRuleRenderedFromTemplate(t *testing.T) {
	rules := []registry.Rule{
		contextTestRule("RULE-EXEC", "execution_safety", "exists"),
		contextTestRule("RULE-SECRET", "data_confidentiality", "not_exists"),
		contextTestRule("RULE-RISK", "risk_escalation", ">="),
		contextTestRule("RULE-AUDIT", "audit", "=="),
		contextTestRule("RULE-PARAM", "parameter_required", "exists"),
		contextTestRule("RULE-QUANTITY", "quantity_threshold", ">"),
		contextTestRule("RULE-RBAC", "rbac", "=="),
		contextTestRule("RULE-GAP", "capability_gap", "!="),
		contextTestRule("RULE-ORDER", "process_order", "before"),
		contextTestRule("RULE-SOD", "separation_of_duties", "!="),
	}
	input := renderTestInput()
	input.Rules = rules
	document, err := Render(input)
	if err != nil {
		t.Fatal(err)
	}
	for _, rule := range rules {
		if count := strings.Count(document.Body, "rule `"+rule.RuleID+"`"); count != 1 {
			t.Fatalf("active rule %s template count=%d", rule.RuleID, count)
		}
	}
}

func TestLLMPromptInstructionIncludedVerbatim(t *testing.T) {
	rule := contextTestRule("RULE-PROMPT", "parameter_required", "exists")
	rule.LLMPromptInstruction = "Use this exact instruction; punctuation, CASE, and spacing stay intact."
	input := renderTestInput()
	input.Rules = []registry.Rule{rule}
	document, err := Render(input)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(document.Body, rule.LLMPromptInstruction) {
		t.Fatalf("LLMPromptInstruction was not included verbatim\n%s", document.Body)
	}
}

func TestContextNeverWrittenToFrozenRegistryPath(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "configs", "registries")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	toolPath := filepath.Join(dir, "all_tools_master_registry.json")
	rulePath := filepath.Join(dir, "all_rules_master_registry.json")
	writeContextJSON(t, toolPath, []registry.Tool{contextTestTool("TOOL-001", "finance.invoice.create", "finance")})
	writeContextJSON(t, rulePath, []registry.Rule{})
	beforeTool := readContextTestFile(t, toolPath)
	beforeRule := readContextTestFile(t, rulePath)
	bundle, err := registry.LoadBundle(toolPath, rulePath, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(registry.NewManager(bundle, toolPath, rulePath), zap.NewNop())
	if _, err := service.Regenerate(); err == nil || !strings.Contains(err.Error(), "frozen evaluation registry") {
		t.Fatalf("frozen context write was not rejected: %v", err)
	}
	if !bytes.Equal(beforeTool, readContextTestFile(t, toolPath)) || !bytes.Equal(beforeRule, readContextTestFile(t, rulePath)) {
		t.Fatal("frozen registry changed during rejected context generation")
	}
}

func renderTestInput() RenderInput {
	return RenderInput{
		RegistryHash:       "sha256:1111111122222222333333334444444455555555666666667777777788888888",
		ToolRegistrySHA256: strings.Repeat("a", 64),
		RuleRegistrySHA256: strings.Repeat("b", 64),
		GeneratedAt:        time.Date(2026, 7, 25, 10, 0, 0, 0, time.UTC),
		Tools:              []registry.Tool{contextTestTool("TOOL-001", "finance.invoice.create", "finance")},
		Rules:              []registry.Rule{contextTestRule("RULE-001", "parameter_required", "exists")},
		SizeCapBytes:       DefaultSizeCap,
	}
}

func contextTestService(t *testing.T, tools []registry.Tool, rules []registry.Rule) (*Service, *registry.Manager, string, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "configs", "runtime")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	toolPath := filepath.Join(dir, "all_tools_master_registry.json")
	rulePath := filepath.Join(dir, "all_rules_master_registry.json")
	writeContextJSON(t, toolPath, tools)
	writeContextJSON(t, rulePath, rules)
	bundle, err := registry.LoadBundle(toolPath, rulePath, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	manager := registry.NewManager(bundle, toolPath, rulePath)
	service := NewService(manager, zap.NewNop())
	service.now = func() time.Time { return time.Date(2026, 7, 25, 10, 0, 0, 0, time.UTC) }
	return service, manager, toolPath, rulePath
}

func contextTestTool(id, name, module string) registry.Tool {
	return registry.Tool{
		ToolID: id, Name: name, DisplayName: name, Module: module,
		Status: "active_mcp_schema_present", Description: "Context test tool",
		BusinessCapability: "Test generation context", Endpoint: "/tools/execute",
		HTTPMethod: "POST", MCPToolName: name,
		InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{
			"amount": map[string]interface{}{"type": "number"},
		}},
		RequiredParameters: []string{"amount"}, OptionalParameters: []string{},
		AllowedRoles: []string{"Platform Admin"}, RiskLevel: "low",
		SideEffects: []string{}, PromptUsageGuidance: "Supply amount.",
	}
}

func contextTestRule(id, ruleType, operator string) registry.Rule {
	value := interface{}("value")
	if ruleType == "process_order" {
		value = []interface{}{"first.tool", "second.tool"}
	}
	return registry.Rule{
		RuleID: id, RuleName: id, RuleType: ruleType, Domain: "global",
		Description: "Context test rule", AppliesToTools: []string{"finance.invoice.create"},
		Condition:         registry.RuleCondition{Type: ruleType, Parameter: "field", Operator: operator, Value: value},
		EnforcementAction: "block", Severity: "high", ValidatorMessage: "Blocked",
		LLMPromptInstruction: "Follow " + id + " exactly.", Enabled: true,
	}
}

func writeContextJSON(t *testing.T, path string, value interface{}) {
	t.Helper()
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw, '\n')
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func readContextTestFile(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
