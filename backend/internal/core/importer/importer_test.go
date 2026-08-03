package importer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"go.uber.org/zap"
)

func TestImporterProducesExactRegistryToolShape(t *testing.T) {
	service, _, _, _ := importerTestService(t, nil, nil)
	tool := importerTestTool("TOOL-IMPORT-001", "finance.invoice.create")
	analysis := analyseValue(t, service, SourceTools, []registry.Tool{tool}, false)
	if len(analysis.Preview.Added) != 1 {
		t.Fatalf("added=%d rejected=%+v", len(analysis.Preview.Added), analysis.Preview.Rejected)
	}
	assertJSONFields(t, analysis.Preview.Added[0].Tool, []string{
		"tool_id", "name", "display_name", "erp_system", "module", "status", "description",
		"business_capability", "bpi_process_alignment", "endpoint", "http_method", "mcp_tool_name",
		"input_schema", "required_parameters", "optional_parameters", "allowed_roles", "risk_level",
		"is_read_only", "side_effects", "preconditions", "postconditions", "failure_modes",
		"validator_checks", "prompt_usage_guidance", "semantic_search_keywords",
		"semantic_search_description", "execution_notes", "current_gaps",
	})
}

func TestImporterProducesExactRegistryRuleShape(t *testing.T) {
	tool := importerTestTool("TOOL-IMPORT-001", "finance.invoice.create")
	service, _, _, _ := importerTestService(t, []registry.Tool{tool}, nil)
	rule := importerTestRule("RULE-IMPORT-001", tool.Name)
	analysis := analyseValue(t, service, SourceRules, []registry.Rule{rule}, false)
	if len(analysis.Preview.Added) != 1 {
		t.Fatalf("added=%d rejected=%+v", len(analysis.Preview.Added), analysis.Preview.Rejected)
	}
	assertJSONFields(t, analysis.Preview.Added[0].Rule, []string{
		"rule_id", "rule_name", "rule_type", "erp_system", "domain", "description",
		"applies_to_tools", "applies_to_roles", "condition", "enforcement_action", "severity",
		"validator_message", "llm_prompt_instruction", "healing_guidance", "bpi_alignment",
		"audit_fields_required", "enabled",
	})
}

func TestRuleWithNoEvaluatorFamilyRejected(t *testing.T) {
	tool := importerTestTool("TOOL-IMPORT-001", "finance.invoice.create")
	service, _, _, _ := importerTestService(t, []registry.Tool{tool}, nil)
	rule := importerTestRule("RULE-CACHE-001", tool.Name)
	rule.RuleType = "cache_safety"
	analysis := analyseValue(t, service, SourceRules, []registry.Rule{rule}, false)
	assertRejectedField(t, analysis, "rule_type", "no implemented evaluator")
}

func TestUnsupportedOperatorRejected(t *testing.T) {
	tool := importerTestTool("TOOL-IMPORT-001", "finance.invoice.create")
	service, _, _, _ := importerTestService(t, []registry.Tool{tool}, nil)
	rule := thresholdRule("RULE-OP-001", tool.Name)
	rule.Condition.Operator = "between"
	analysis := analyseValue(t, service, SourceRules, []registry.Rule{rule}, false)
	assertRejectedField(t, analysis, "condition.operator", "not implemented")
}

// The registry loader does not type-check condition.value, and this check is
// not on the agreed list of importer-only checks, so it no longer rejects.
// See the report note: restoring it is a one-line change in validateRule.
func TestOperatorValueTypeMismatchAccepted(t *testing.T) {
	tool := importerTestTool("TOOL-IMPORT-001", "finance.invoice.create")
	service, _, _, _ := importerTestService(t, []registry.Tool{tool}, nil)
	rule := thresholdRule("RULE-TYPE-001", tool.Name)
	rule.Condition.Value = "one hundred"
	analysis := analyseValue(t, service, SourceRules, []registry.Rule{rule}, false)
	if len(analysis.Preview.Rejected) != 0 {
		t.Fatalf("rejected=%+v", analysis.Preview.Rejected)
	}
}

func TestRuleMatchingZeroToolsRejected(t *testing.T) {
	tool := importerTestTool("TOOL-IMPORT-001", "finance.invoice.create")
	service, _, _, _ := importerTestService(t, []registry.Tool{tool}, nil)
	rule := importerTestRule("RULE-ZERO-001", "missing.tool.action")
	analysis := analyseValue(t, service, SourceRules, []registry.Rule{rule}, false)
	assertRejectedField(t, analysis, "applies_to_tools", "matches zero tools")
}

// The registry loader accepts any non-empty name, and the shipped registry
// holds two-segment (demo.echo) and undotted (classify_invoice) names. The
// importer must accept every shape the registry accepts.
func TestToolNameShapesAcceptedByRegistryAreAccepted(t *testing.T) {
	for _, name := range []string{"finance.create", "demo.echo", "classify_invoice", "finance.invoice.create"} {
		service, _, _, _ := importerTestService(t, nil, nil)
		tool := importerTestTool("TOOL-NAMESPACE-001", name)
		analysis := analyseValue(t, service, SourceTools, []registry.Tool{tool}, false)
		if len(analysis.Preview.Rejected) != 0 {
			t.Fatalf("name %q rejected=%+v", name, analysis.Preview.Rejected)
		}
		if len(analysis.Preview.Added) != 1 {
			t.Fatalf("name %q added=%d, want 1", name, len(analysis.Preview.Added))
		}
	}
}

func TestToolNameWithWhitespaceRejected(t *testing.T) {
	service, _, _, _ := importerTestService(t, nil, nil)
	tool := importerTestTool("TOOL-NAMESPACE-002", "finance create")
	analysis := analyseValue(t, service, SourceTools, []registry.Tool{tool}, false)
	assertRejectedField(t, analysis, "name", "whitespace")
}

// decodeToolStrict requires only that input_schema is present, so the importer
// no longer rejects an untyped declared parameter.
func TestToolWithUntypedParameterAccepted(t *testing.T) {
	service, _, _, _ := importerTestService(t, nil, nil)
	tool := importerTestTool("TOOL-TYPE-001", "finance.invoice.create")
	tool.InputSchema["properties"] = map[string]interface{}{"amount": map[string]interface{}{}}
	analysis := analyseValue(t, service, SourceTools, []registry.Tool{tool}, false)
	if len(analysis.Preview.Rejected) != 0 {
		t.Fatalf("rejected=%+v", analysis.Preview.Rejected)
	}
}

func TestOpenAPIRequiresPerToolConfirmation(t *testing.T) {
	service, _, _, _ := importerTestService(t, nil, nil)
	analysis, err := service.Analyse(AnalyseInput{
		Filename: "api.yaml", Content: []byte(openAPITestDocument()), Kind: SourceOpenAPI, Prefix: "finance.invoice",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(analysis.Preview.Added) != 1 || !analysis.Preview.Added[0].RequiresConfirmation {
		t.Fatalf("OpenAPI record did not require confirmation: %+v", analysis.Preview)
	}
}

func TestOpenAPIExternalRefRejected(t *testing.T) {
	service, _, _, _ := importerTestService(t, nil, nil)
	document := strings.Replace(openAPITestDocument(), "type: string", "$ref: https://example.test/customer.yaml#/Customer", 1)
	analysis, err := service.Analyse(AnalyseInput{
		Filename: "api.yaml", Content: []byte(document), Kind: SourceOpenAPI, Prefix: "finance.invoice",
	})
	if err != nil {
		t.Fatal(err)
	}
	assertRejectedField(t, analysis, "operation", "external reference")
}

func TestOpenAPIResponseSchemaStoredInImportRecordNotTool(t *testing.T) {
	service, _, _, _ := importerTestService(t, nil, nil)
	analysis, err := service.Analyse(AnalyseInput{
		Filename: "api.yaml", Content: []byte(openAPITestDocument()), Kind: SourceOpenAPI, Prefix: "finance.invoice",
	})
	if err != nil {
		t.Fatal(err)
	}
	record := analysis.Preview.Added[0]
	if record.Metadata["response_schema"] == nil {
		t.Fatal("response schema was not captured in import metadata")
	}
	raw, err := json.Marshal(record.Tool)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "response_schema") || strings.Contains(string(raw), "responses") {
		t.Fatalf("response schema leaked into registry.Tool: %s", raw)
	}
}

func TestReimportIsIdempotent(t *testing.T) {
	tool := importerTestTool("TOOL-IMPORT-001", "finance.invoice.create")
	service, _, _, _ := importerTestService(t, []registry.Tool{tool}, nil)
	analysis := analyseValue(t, service, SourceTools, []registry.Tool{tool}, false)
	if len(analysis.Preview.Unchanged) != 1 || len(analysis.Preview.Added)+len(analysis.Preview.Updated)+len(analysis.Preview.Rejected) != 0 {
		t.Fatalf("re-import was not all unchanged: %+v", analysis.Preview)
	}
}

func TestAnalysePersistsNothing(t *testing.T) {
	service, manager, toolPath, rulePath := importerTestService(t, nil, nil)
	toolBefore := mustRead(t, toolPath)
	ruleBefore := mustRead(t, rulePath)
	hashBefore := manager.Hash()
	tool := importerTestTool("TOOL-IMPORT-001", "finance.invoice.create")
	analysis := analyseValue(t, service, SourceTools, []registry.Tool{tool}, false)
	if len(analysis.Preview.Added) != 1 {
		t.Fatalf("analysis did not produce added record: %+v", analysis.Preview)
	}
	if !reflect.DeepEqual(toolBefore, mustRead(t, toolPath)) || !reflect.DeepEqual(ruleBefore, mustRead(t, rulePath)) || hashBefore != manager.Hash() {
		t.Fatal("analyse changed registry files or the live registry hash")
	}
}

func TestCommitRollsBackOnPartialFailure(t *testing.T) {
	service, manager, toolPath, rulePath := importerTestService(t, nil, nil)
	tools := []registry.Tool{
		importerTestTool("TOOL-ROLLBACK-001", "finance.invoice.create"),
		importerTestTool("TOOL-ROLLBACK-002", "finance.invoice.cancel"),
	}
	analysis := analyseValue(t, service, SourceTools, tools, false)
	stored := service.analyses[analysis.ID]
	stored.Preview.Added[1].Tool.Name = stored.Preview.Added[0].Tool.Name
	stored.Preview.Added[1].Tool.MCPToolName = stored.Preview.Added[0].Tool.Name
	toolBefore := mustRead(t, toolPath)
	ruleBefore := mustRead(t, rulePath)
	_, err := service.Commit(analysis.ID, CommitOptions{SelectedRecordIDs: []string{
		analysis.Preview.Added[0].RecordID, analysis.Preview.Added[1].RecordID,
	}})
	if err == nil || !strings.Contains(err.Error(), analysis.Preview.Added[1].RecordID) || !strings.Contains(err.Error(), "both registry backups were restored") {
		t.Fatalf("commit error did not name failed record and rollback: %v", err)
	}
	if !reflect.DeepEqual(toolBefore, mustRead(t, toolPath)) || !reflect.DeepEqual(ruleBefore, mustRead(t, rulePath)) {
		t.Fatal("partial failure did not restore both registry files")
	}
	if len(manager.Tools()) != 0 {
		t.Fatalf("partial failure left %d tools in the live registry", len(manager.Tools()))
	}
}

func TestOrphanedRulesSurfacedInDiff(t *testing.T) {
	tool := importerTestTool("TOOL-IMPORT-001", "finance.invoice.create")
	rule := importerTestRule("RULE-IMPORT-001", tool.Name)
	service, _, _, _ := importerTestService(t, []registry.Tool{tool}, []registry.Rule{rule})
	renamed := tool
	renamed.Name = "finance.invoice.submit"
	renamed.MCPToolName = renamed.Name
	analysis := analyseValue(t, service, SourceTools, []registry.Tool{renamed}, true)
	if len(analysis.Preview.Orphaned) != 1 || analysis.Preview.Orphaned[0].SourceID != rule.RuleID {
		t.Fatalf("orphaned rule was not surfaced: %+v", analysis.Preview.Orphaned)
	}
}

func TestPerRecordErrorReportsLineAndField(t *testing.T) {
	service, _, _, _ := importerTestService(t, nil, nil)
	content := []byte("[\n  {\n    \"tool_id\": \"TOOL-BAD-001\",\n    \"display_name\": \"Missing name\"\n  }\n]\n")
	analysis, err := service.Analyse(AnalyseInput{Filename: "tools.json", Content: content, Kind: SourceTools})
	if err != nil {
		t.Fatal(err)
	}
	if len(analysis.Preview.Rejected) != 1 {
		t.Fatalf("rejected=%d", len(analysis.Preview.Rejected))
	}
	found := false
	for _, recordErr := range analysis.Preview.Rejected[0].Errors {
		if recordErr.Field == "name" && recordErr.Line == 2 && recordErr.Index == 0 {
			found = true
		}
	}
	if !found {
		t.Fatalf("line/index/field evidence missing: %+v", analysis.Preview.Rejected[0].Errors)
	}
}

func TestImportNeverWritesSeedOrExperimentPaths(t *testing.T) {
	for _, relative := range []string{
		filepath.Join("configs", "seed"),
		filepath.Join("configs", "registries"),
		filepath.Join("dataset", "eval"),
		filepath.Join("cmd", "run-experiment"),
	} {
		t.Run(filepath.ToSlash(relative), func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), relative)
			if err := os.MkdirAll(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			toolName := "tools.json"
			ruleName := "rules.json"
			if strings.Contains(filepath.ToSlash(relative), "configs/registries") {
				toolName = "all_tools_master_registry.json"
				ruleName = "all_rules_master_registry.json"
			}
			toolPath := filepath.Join(dir, toolName)
			rulePath := filepath.Join(dir, ruleName)
			writeJSON(t, toolPath, []registry.Tool{})
			writeJSON(t, rulePath, []registry.Rule{})
			bundle, err := registry.LoadBundle(toolPath, rulePath, zap.NewNop())
			if err != nil {
				t.Fatal(err)
			}
			service := NewService(registry.NewManager(bundle, toolPath, rulePath), zap.NewNop())
			analysis := analyseValue(t, service, SourceTools, []registry.Tool{importerTestTool("TOOL-SAFE-001", "finance.invoice.create")}, false)
			before := mustRead(t, toolPath)
			_, err = service.Commit(analysis.ID, CommitOptions{SelectedRecordIDs: []string{analysis.Preview.Added[0].RecordID}})
			if err == nil {
				t.Fatal("commit to protected seed/experiment path succeeded")
			}
			if !reflect.DeepEqual(before, mustRead(t, toolPath)) {
				t.Fatal("protected registry path was written")
			}
		})
	}
}

func TestImportCannotWriteFrozenEvalRegistry(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "configs", "registries")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	toolPath := filepath.Join(dir, "all_tools_master_registry.json")
	rulePath := filepath.Join(dir, "all_rules_master_registry.json")
	writeJSON(t, toolPath, []registry.Tool{})
	writeJSON(t, rulePath, []registry.Rule{})
	bundle, err := registry.LoadBundle(toolPath, rulePath, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(registry.NewManager(bundle, toolPath, rulePath), zap.NewNop())
	analysis := analyseValue(t, service, SourceTools, []registry.Tool{importerTestTool("TOOL-FROZEN-001", "finance.invoice.create")}, false)
	before := mustRead(t, toolPath)
	_, err = service.Commit(analysis.ID, CommitOptions{SelectedRecordIDs: []string{analysis.Preview.Added[0].RecordID}})
	if err == nil || !strings.Contains(err.Error(), "frozen evaluation registry") {
		t.Fatalf("frozen evaluation import was not rejected by the central guard: %v", err)
	}
	if !reflect.DeepEqual(before, mustRead(t, toolPath)) {
		t.Fatal("frozen evaluation registry changed after rejected import")
	}
}

func TestImportCommitRegeneratesContext(t *testing.T) {
	service, manager, _, _ := importerTestService(t, nil, nil)
	before, err := service.context.Regenerate()
	if err != nil {
		t.Fatal(err)
	}
	tool := importerTestTool("TOOL-CONTEXT-001", "finance.context.import")
	analysis := analyseValue(t, service, SourceTools, []registry.Tool{tool}, false)
	if _, err := service.Commit(analysis.ID, CommitOptions{SelectedRecordIDs: []string{analysis.Preview.Added[0].RecordID}}); err != nil {
		t.Fatal(err)
	}
	after, err := service.context.Current()
	if err != nil {
		t.Fatal(err)
	}
	if after.FrontMatter.RegistryHash == before.FrontMatter.RegistryHash || after.FrontMatter.RegistryHash != manager.Hash() {
		t.Fatalf("import context was not regenerated: before=%s after=%s active=%s", before.FrontMatter.RegistryHash, after.FrontMatter.RegistryHash, manager.Hash())
	}
	if !strings.Contains(after.Markdown, tool.Name) {
		t.Fatalf("imported tool is absent from regenerated context: %s", tool.Name)
	}
}

// TestExistingRegistryReimportsWithoutRejection enforces the governing
// principle: the importer must never reject a record the registry loader
// accepts. It replays the live registry files back through analyse as if they
// were an upload and requires a zero-rejection, all-Unchanged diff.
func TestExistingRegistryReimportsWithoutRejection(t *testing.T) {
	toolRaw, ruleRaw := currentRegistryBytes(t)

	dir := t.TempDir()
	toolPath := filepath.Join(dir, "runtime-tools.json")
	rulePath := filepath.Join(dir, "runtime-rules.json")
	if err := os.WriteFile(toolPath, toolRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rulePath, ruleRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	bundle, err := registry.LoadBundle(toolPath, rulePath, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	manager := registry.NewManager(bundle, toolPath, rulePath)
	service := NewService(manager, zap.NewNop())

	for _, item := range []struct {
		label   string
		kind    SourceKind
		content []byte
		total   int
	}{
		{"tools", SourceTools, toolRaw, len(manager.Tools())},
		{"rules", SourceRules, ruleRaw, len(manager.Rules())},
	} {
		analysis, analyseErr := service.Analyse(AnalyseInput{Filename: item.label + ".json", Content: item.content, Kind: item.kind})
		if analyseErr != nil {
			t.Fatalf("%s: analyse: %v", item.label, analyseErr)
		}
		if len(analysis.Preview.Rejected) != 0 {
			t.Fatalf("%s: importer is still stricter than the registry, rejected %d record(s): %+v",
				item.label, len(analysis.Preview.Rejected), analysis.Preview.Rejected)
		}
		if len(analysis.Preview.Added) != 0 || len(analysis.Preview.Updated) != 0 {
			t.Fatalf("%s: added=%d updated=%d, want 0 and 0", item.label, len(analysis.Preview.Added), len(analysis.Preview.Updated))
		}
		if item.total == 0 {
			t.Fatalf("%s: registry fixture is empty", item.label)
		}
		if len(analysis.Preview.Unchanged) != item.total {
			t.Fatalf("%s: unchanged=%d, want %d", item.label, len(analysis.Preview.Unchanged), item.total)
		}
	}
}

// currentRegistryBytes prefers the generated runtime registry and falls back to
// the committed frozen registry so the test also runs on a fresh clone.
func currentRegistryBytes(t *testing.T) ([]byte, []byte) {
	t.Helper()
	for _, dir := range []string{
		filepath.Join("..", "..", "..", "configs", "runtime"),
		filepath.Join("..", "..", "..", "configs", "registries"),
	} {
		toolRaw, toolErr := os.ReadFile(filepath.Join(dir, "all_tools_master_registry.json"))
		ruleRaw, ruleErr := os.ReadFile(filepath.Join(dir, "all_rules_master_registry.json"))
		if toolErr == nil && ruleErr == nil {
			return toolRaw, ruleRaw
		}
	}
	t.Fatal("neither configs/runtime nor configs/registries holds a readable registry pair")
	return nil, nil
}

func importerTestService(t *testing.T, tools []registry.Tool, rules []registry.Rule) (*Service, *registry.Manager, string, string) {
	t.Helper()
	dir := t.TempDir()
	toolPath := filepath.Join(dir, "runtime-tools.json")
	rulePath := filepath.Join(dir, "runtime-rules.json")
	if tools == nil {
		tools = []registry.Tool{}
	}
	if rules == nil {
		rules = []registry.Rule{}
	}
	writeJSON(t, toolPath, tools)
	writeJSON(t, rulePath, rules)
	bundle, err := registry.LoadBundle(toolPath, rulePath, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	manager := registry.NewManager(bundle, toolPath, rulePath)
	return NewService(manager, zap.NewNop()), manager, toolPath, rulePath
}

func importerTestTool(id, name string) registry.Tool {
	return registry.Tool{
		ToolID: id, Name: name, DisplayName: name, ERPSystem: "demo", Module: "finance",
		Status: "active_mcp_schema_present", Description: "Imported test tool",
		BusinessCapability: "Invoice processing", BPIProcessAlignment: []string{"Invoice processing"},
		Endpoint: "/tools/execute", HTTPMethod: "POST", MCPToolName: name,
		InputSchema: map[string]interface{}{
			"type": "object", "properties": map[string]interface{}{"amount": map[string]interface{}{"type": "number", "minimum": float64(0)}},
			"required": []interface{}{"amount"},
		},
		RequiredParameters: []string{"amount"}, OptionalParameters: []string{},
		AllowedRoles: []string{"Platform Admin"}, RiskLevel: "medium", IsReadOnly: false,
		SideEffects: []string{"Creates a record"}, Preconditions: []string{}, Postconditions: []string{},
		FailureModes: []string{"Connector unavailable"}, ValidatorChecks: []string{"tool_exists", "parameters_present"},
		PromptUsageGuidance: "Provide amount.", SemanticSearchKeywords: []string{"invoice"},
		SemanticSearchDescription: "Creates an invoice.", ExecutionNotes: "Test import.", CurrentGaps: []string{},
	}
}

func importerTestRule(id, toolName string) registry.Rule {
	return registry.Rule{
		RuleID: id, RuleName: "Imported policy", RuleType: "parameter_required", ERPSystem: "demo",
		Domain: "finance", Description: "Amount is required", AppliesToTools: []string{toolName},
		AppliesToRoles: []string{}, Condition: registry.RuleCondition{
			Type: "parameter_required", Parameter: "required_parameters", Operator: "exists", Value: []interface{}{"amount"},
		},
		EnforcementAction: "block", Severity: "high", ValidatorMessage: "Amount is required",
		LLMPromptInstruction: "Include amount.", HealingGuidance: "Ask for amount.",
		BPIAlignment: []string{"Invoice processing"}, AuditFieldsRequired: []string{"amount"}, Enabled: true,
	}
}

func thresholdRule(id, toolName string) registry.Rule {
	rule := importerTestRule(id, toolName)
	rule.RuleType = "amount_threshold"
	rule.Condition = registry.RuleCondition{Type: "amount_threshold", Parameter: "amount", Operator: ">", Value: float64(100)}
	rule.EnforcementAction = "require_human_approval"
	return rule
}

func analyseValue(t *testing.T, service *Service, kind SourceKind, value interface{}, allowUpdates bool) Analysis {
	t.Helper()
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	analysis, err := service.Analyse(AnalyseInput{Filename: string(kind) + ".json", Content: raw, Kind: kind, AllowUpdates: allowUpdates})
	if err != nil {
		t.Fatal(err)
	}
	return analysis
}

func assertRejectedField(t *testing.T, analysis Analysis, field, reason string) {
	t.Helper()
	if len(analysis.Preview.Rejected) == 0 {
		t.Fatalf("expected rejection for %s, preview=%+v", field, analysis.Preview)
	}
	for _, record := range analysis.Preview.Rejected {
		for _, recordErr := range record.Errors {
			if recordErr.Field == field && strings.Contains(recordErr.Reason, reason) {
				return
			}
		}
	}
	t.Fatalf("rejection did not contain field=%s reason=%q: %+v", field, reason, analysis.Preview.Rejected)
}

func assertJSONFields(t *testing.T, value interface{}, expected []string) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]interface{}
	if err := json.Unmarshal(raw, &object); err != nil {
		t.Fatal(err)
	}
	actual := make([]string, 0, len(object))
	for key := range object {
		actual = append(actual, key)
	}
	sortStrings(actual)
	sortStrings(expected)
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("JSON fields differ\nactual:   %v\nexpected: %v\nraw: %s", actual, expected, raw)
	}
}

func sortStrings(values []string) {
	for i := 0; i < len(values); i++ {
		for j := i + 1; j < len(values); j++ {
			if values[j] < values[i] {
				values[i], values[j] = values[j], values[i]
			}
		}
	}
}

func writeJSON(t *testing.T, path string, value interface{}) {
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

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func openAPITestDocument() string {
	return `openapi: 3.0.3
info:
  title: Invoice API
  version: "1.0"
paths:
  /invoices:
    post:
      operationId: CreateInvoice
      summary: Create invoice
      parameters:
        - name: tenant_id
          in: header
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [amount]
              properties:
                amount:
                  type: number
                  minimum: 0
                  maximum: 10000
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                type: object
                required: [invoice_id]
                properties:
                  invoice_id:
                    type: string
`
}
