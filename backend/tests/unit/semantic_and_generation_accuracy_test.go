package unit

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/semanticsearch"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/synthesizer"
)

type semanticSearchCase struct {
	CaseID        string   `json:"case_id"`
	Query         string   `json:"query"`
	UserRole      string   `json:"user_role"`
	PrimaryTool   string   `json:"primary_tool"`
	ExpectedTools []string `json:"expected_tools"`
	ExpectedRules []string `json:"expected_rules"`
	Focus         string   `json:"focus"`
}

type semanticSearchOutcome struct {
	CaseID           string   `json:"case_id"`
	Focus            string   `json:"focus"`
	Query            string   `json:"query"`
	UserRole         string   `json:"user_role"`
	PrimaryTool      string   `json:"primary_tool"`
	TopTool          string   `json:"top_tool"`
	ToolRank         int      `json:"tool_rank"`
	ExpectedTools    []string `json:"expected_tools"`
	RetrievedTools   []string `json:"retrieved_tools"`
	MissingTools     []string `json:"missing_tools"`
	ExpectedRules    []string `json:"expected_rules"`
	RetrievedRules   []string `json:"retrieved_rules"`
	MissingRules     []string `json:"missing_rules"`
	ToolsOK          bool     `json:"tools_ok"`
	RulesOK          bool     `json:"rules_ok"`
	Correct          bool     `json:"correct"`
	ReciprocalRank   float64  `json:"reciprocal_rank"`
	RetrievalMethod  string   `json:"retrieval_method"`
	GlobalRuleCount  int      `json:"global_rule_count"`
	TemplateHitCount int      `json:"template_hit_count"`
	ExampleHitCount  int      `json:"example_hit_count"`
	LoadedToolCount  int      `json:"loaded_tool_count"`
	LoadedRuleCount  int      `json:"loaded_rule_count"`
}

type semanticSearchMetrics struct {
	Total                  int     `json:"total"`
	FullyCorrect           int     `json:"fully_correct"`
	ToolAllHit             int     `json:"tool_all_hit"`
	RuleAllHit             int     `json:"rule_all_hit"`
	Top1ToolHit            int     `json:"top1_tool_hit"`
	ExpectedToolTotal      int     `json:"expected_tool_total"`
	MatchedToolTotal       int     `json:"matched_tool_total"`
	ExpectedRuleTotal      int     `json:"expected_rule_total"`
	MatchedRuleTotal       int     `json:"matched_rule_total"`
	Accuracy               float64 `json:"accuracy"`
	ToolSetRecall          float64 `json:"tool_set_recall"`
	RuleSetRecall          float64 `json:"rule_set_recall"`
	Top1ToolAccuracy       float64 `json:"top1_tool_accuracy"`
	MeanReciprocalRank     float64 `json:"mean_reciprocal_rank"`
	AverageExpectedTools   float64 `json:"average_expected_tools"`
	AverageExpectedRules   float64 `json:"average_expected_rules"`
	AverageGlobalRuleCount float64 `json:"average_global_rule_count"`
	LoadedToolCount        int     `json:"loaded_tool_count"`
	LoadedRuleCount        int     `json:"loaded_rule_count"`
	LoadedTemplateCount    int     `json:"loaded_template_count"`
	LoadedExampleCount     int     `json:"loaded_example_count"`
}

type liveGeminiScenario struct {
	CaseID         string   `json:"case_id"`
	Title          string   `json:"title"`
	Prompt         string   `json:"prompt"`
	UserRole       string   `json:"user_role"`
	ExpectedResult string   `json:"expected_result"`
	RequiredTools  []string `json:"required_tools"`
	Focus          string   `json:"focus"`
}

func TestSemanticSearchGeneratedAccuracyReport(t *testing.T) {
	const generatedCaseCount = 1000

	bundle := loadDatasetFixture(t)
	search := semanticsearch.NewService(bundle.Tools, bundle.Rules, "go_lexical")
	cases := generateSemanticSearchCases(generatedCaseCount)

	outcomes, metrics := evaluateSemanticSearchCases(t, search, bundle, cases)
	reportDir := filepath.Join(repoRootFromTest(t), "test-results")
	writeSemanticSearchReports(t, reportDir, metrics, outcomes)

	t.Logf("semantic search report: %s", filepath.Join(reportDir, "semantic_search_accuracy_report.html"))
	t.Logf("semantic search metrics: loaded_tools=%d loaded_rules=%d total=%d accuracy=%.3f tool_recall=%.3f rule_recall=%.3f top1=%.3f mrr=%.3f",
		metrics.LoadedToolCount, metrics.LoadedRuleCount, metrics.Total, metrics.Accuracy, metrics.ToolSetRecall, metrics.RuleSetRecall, metrics.Top1ToolAccuracy, metrics.MeanReciprocalRank)

	if metrics.Accuracy < 0.85 || metrics.ToolSetRecall < 0.90 || metrics.RuleSetRecall < 0.95 || metrics.MeanReciprocalRank < 0.70 {
		t.Fatalf("semantic search metrics below acceptance threshold: %+v", metrics)
	}
}

func TestGeminiGenerationGeneratedLongFlowAccuracyReport(t *testing.T) {
	const generatedFlowCount = 5000
	const batchSize = 5

	expectedCases := generateLongValidatorAccuracyCases(generatedFlowCount)
	generator, closeFn := newSequencedMockGeminiGenerator(t, expectedCases, batchSize)
	defer closeFn()

	bundle := loadRegistryFixture(t)
	validator := newRegistryValidator(t)
	generatedCases := make([]validatorAccuracyCase, 0, generatedFlowCount)

	for start := 0; start < len(expectedCases); start += batchSize {
		end := start + batchSize
		if end > len(expectedCases) {
			end = len(expectedCases)
		}
		candidates, err := generator.GenerateCandidates(context.Background(), synthesizer.CandidateGenerationRequest{
			Prompt:         fmt.Sprintf("Generate validator accuracy batch %d to %d with long workflows.", start+1, end),
			UserRole:       "Workflow Builder",
			Mode:           "generate_workflow",
			CandidateCount: end - start,
			Tools:          bundle.Tools.GetAllTools(),
			Rules:          nonGlobalRules(bundle.Rules.GetEnabledRules()),
			GlobalRules:    bundle.Rules.GetGlobalSafetyRules(),
		})
		if err != nil {
			t.Fatalf("gemini generation batch %d returned error: %v", start/batchSize+1, err)
		}
		if len(candidates) != end-start {
			t.Fatalf("gemini generation batch %d expected %d candidates, got %d", start/batchSize+1, end-start, len(candidates))
		}

		for offset, candidate := range candidates {
			expected := expectedCases[start+offset]
			lines := strings.Split(strings.TrimSpace(candidate.RawYAML), "\n")
			if stepCount := countWorkflowActionLines(lines); stepCount < minGeneratedLongFlowSteps {
				t.Fatalf("%s generated by Gemini mock is not long enough: expected at least %d steps, got %d", expected.CaseID, minGeneratedLongFlowSteps, stepCount)
			}
			generatedCases = append(generatedCases, validatorAccuracyCase{
				CaseID:         expected.CaseID,
				Title:          "Gemini generated " + expected.Title,
				UserRole:       expected.UserRole,
				ExpectedResult: expected.ExpectedResult,
				Focus:          expected.Focus,
				YAMLLines:      lines,
			})
		}
	}

	outcomes, metrics := evaluateValidatorCases(t, validator, generatedCases, false)
	reportDir := filepath.Join(repoRootFromTest(t), "test-results")
	writeValidatorReportsNamed(t, reportDir, "gemini_generation_5000", "Gemini Generation 5000 Long Flow Accuracy Report", metrics, outcomes)
	writeValidatorFlowDataset(t, filepath.Join(reportDir, "gemini_generation_5000_flows.jsonl"), generatedCases)

	t.Logf("gemini generation report: %s", filepath.Join(reportDir, "gemini_generation_5000_report.html"))
	t.Logf("gemini generation dataset: %s", filepath.Join(reportDir, "gemini_generation_5000_flows.jsonl"))
	t.Logf("gemini generation metrics: total=%d accuracy=%.3f precision=%.3f recall=%.3f specificity=%.3f f1=%.3f mcc=%.3f",
		metrics.Total, metrics.Accuracy, metrics.Precision, metrics.Recall, metrics.Specificity, metrics.F1, metrics.MCC)

	if metrics.Accuracy < 0.85 || metrics.F1 < 0.85 || metrics.MCC < 0.75 {
		t.Fatalf("gemini generation metrics below acceptance threshold: %+v", metrics)
	}
}

func TestGeminiLiveAPIGenerationAccuracyReport(t *testing.T) {
	if !envFlagEnabled("RUN_GEMINI_LIVE_TEST") {
		t.Skip("set RUN_GEMINI_LIVE_TEST=1 and GEMINI_API_KEY to run the live Gemini API accuracy check")
	}
	apiKey := strings.TrimSpace(os.Getenv("GEMINI_API_KEY"))
	if apiKey == "" {
		t.Skip("GEMINI_API_KEY is required for the live Gemini API accuracy check")
	}

	caseCount := liveGeminiCaseCount()
	model := firstNonEmpty(os.Getenv("GEMINI_MODEL"), "gemini-2.5-flash")
	bundle := loadRegistryFixture(t)
	search := semanticsearch.NewService(bundle.Tools, bundle.Rules, "go_lexical")
	generator := synthesizer.NewServiceWithProvider("", "", false, "gemini", apiKey, model)
	validator := newRegistryValidator(t)
	scenarios := generateLiveGeminiScenarios(caseCount)

	outcomes := make([]validatorCaseOutcome, 0, len(scenarios))
	metrics := validatorAccuracyMetrics{Total: len(scenarios)}
	generatedCases := make([]validatorAccuracyCase, 0, len(scenarios))

	for _, scenario := range scenarios {
		retrieval, err := search.SearchContext(context.Background(), scenario.Prompt, scenario.UserRole, semanticsearch.Options{
			TopKTools: 10,
			TopKRules: 15,
		})
		if err != nil {
			t.Fatalf("%s live Gemini retrieval failed: %v", scenario.CaseID, err)
		}

		candidates, err := generator.GenerateCandidates(context.Background(), synthesizer.CandidateGenerationRequest{
			Prompt:         scenario.Prompt,
			UserRole:       scenario.UserRole,
			Mode:           "generate_workflow",
			CandidateCount: 1,
			Tools:          toolsFromResults(retrieval.Tools),
			Rules:          rulesFromResults(retrieval.Rules),
			GlobalRules:    rulesFromResults(retrieval.GlobalRules),
			Templates:      templatesFromResults(retrieval.Templates),
			Examples:       examplesFromResults(retrieval.Examples),
		})
		if err != nil {
			outcome, expectedPass, predictedPass := liveGeminiErrorOutcome(scenario, err)
			updateValidatorMetrics(&metrics, expectedPass, predictedPass)
			outcomes = append(outcomes, outcome)
			continue
		}

		candidate := candidates[0]
		validation := validator.ValidateCandidate(scenario.CaseID, candidate.RawYAML, scenario.UserRole)
		missingRequiredTools := missingStrings(scenario.RequiredTools, workflowActions(candidate.RawYAML))
		expectedPass := strings.EqualFold(scenario.ExpectedResult, "PASS")
		predictedPass := validation.Passed
		errors := append([]string{}, validation.Errors...)
		if expectedPass && len(missingRequiredTools) > 0 {
			predictedPass = false
			errors = append(errors, "LIVE_GEMINI_MISSING_REQUIRED_TOOLS: "+strings.Join(missingRequiredTools, ", "))
		}
		predictedResult := "BLOCK"
		if predictedPass {
			predictedResult = "PASS"
		}
		updateValidatorMetrics(&metrics, expectedPass, predictedPass)

		lines := strings.Split(strings.TrimSpace(candidate.RawYAML), "\n")
		outcomes = append(outcomes, validatorCaseOutcome{
			CaseID:          scenario.CaseID,
			Title:           scenario.Title,
			Focus:           scenario.Focus,
			UserRole:        scenario.UserRole,
			ExpectedResult:  strings.ToUpper(scenario.ExpectedResult),
			PredictedResult: predictedResult,
			Correct:         expectedPass == predictedPass,
			Score:           validation.Score,
			FailedRules:     validation.FailedRules,
			Errors:          errors,
		})
		generatedCases = append(generatedCases, validatorAccuracyCase{
			CaseID:         scenario.CaseID,
			Title:          scenario.Title,
			UserRole:       scenario.UserRole,
			ExpectedResult: scenario.ExpectedResult,
			Focus:          scenario.Focus,
			YAMLLines:      lines,
		})
	}

	metrics = finalizeValidatorMetrics(metrics)
	reportDir := filepath.Join(repoRootFromTest(t), "test-results")
	writeValidatorReportsNamed(t, reportDir, "gemini_live_api", "Live Gemini API Generation Accuracy Report", metrics, outcomes)
	writeValidatorFlowDataset(t, filepath.Join(reportDir, "gemini_live_api_flows.jsonl"), generatedCases)

	t.Logf("live Gemini API report: %s", filepath.Join(reportDir, "gemini_live_api_report.html"))
	t.Logf("live Gemini API metrics: total=%d accuracy=%.3f precision=%.3f recall=%.3f specificity=%.3f f1=%.3f mcc=%.3f",
		metrics.Total, metrics.Accuracy, metrics.Precision, metrics.Recall, metrics.Specificity, metrics.F1, metrics.MCC)

	minAccuracy := liveGeminiMinAccuracy()
	if metrics.Accuracy < minAccuracy {
		t.Fatalf("live Gemini API accuracy %.3f below threshold %.3f", metrics.Accuracy, minAccuracy)
	}
}

func generateLiveGeminiScenarios(count int) []liveGeminiScenario {
	patterns := []func(int) liveGeminiScenario{
		liveGeminiProcurementScenario,
		liveGeminiFinanceClearingScenario,
		liveGeminiNotificationScenario,
		liveGeminiCapabilityScenario,
		liveGeminiEmployeeBlockedScenario,
	}
	out := make([]liveGeminiScenario, 0, count)
	for i := 1; i <= count; i++ {
		out = append(out, patterns[(i-1)%len(patterns)](i))
	}
	return out
}

func liveGeminiProcurementScenario(i int) liveGeminiScenario {
	return liveGeminiScenario{
		CaseID:         fmt.Sprintf("LIVE-GEM-%04d", i),
		Title:          "Live Gemini procurement workflow",
		Prompt:         fmt.Sprintf("Generate a long executable workflow with at least 8 steps: validate vendor V-%04d, check procurement policy, create a purchase order for item ITEM-%04d quantity 150, request human approval, notify finance, and write audit log.", i, i),
		UserRole:       "Workflow Builder",
		ExpectedResult: "PASS",
		RequiredTools:  []string{"procurement.validate_vendor", "procurement.create_purchase_order", "approval.request_human_approval", "audit.write_audit_log"},
		Focus:          "live API procurement generation",
	}
}

func liveGeminiFinanceClearingScenario(i int) liveGeminiScenario {
	return liveGeminiScenario{
		CaseID:         fmt.Sprintf("LIVE-GEM-%04d", i),
		Title:          "Live Gemini finance clearing workflow",
		Prompt:         fmt.Sprintf("Generate a long executable workflow with at least 8 steps: record invoice receipt INV-%04d, record goods receipt for purchase order PO-%04d, request finance approval, clear the invoice only after receipts, notify finance, and write audit log.", i, i),
		UserRole:       "Workflow Builder",
		ExpectedResult: "PASS",
		RequiredTools:  []string{"finance.record_invoice_receipt", "inventory.record_goods_receipt", "finance.clear_invoice", "approval.request_human_approval", "audit.write_audit_log"},
		Focus:          "live API invoice clearing generation",
	}
}

func liveGeminiNotificationScenario(i int) liveGeminiScenario {
	return liveGeminiScenario{
		CaseID:         fmt.Sprintf("LIVE-GEM-%04d", i),
		Title:          "Live Gemini notification workflow",
		Prompt:         fmt.Sprintf("Generate a long executable workflow with at least 8 steps: classify invoice exception INV-%04d, check finance policy, notify finance, send webhook callback, and write audit log.", i),
		UserRole:       "Workflow Builder",
		ExpectedResult: "PASS",
		RequiredTools:  []string{"classify_invoice", "policy.check_policy_limit", "notify_finance", "send_webhook", "audit.write_audit_log"},
		Focus:          "live API notification generation",
	}
}

func liveGeminiCapabilityScenario(i int) liveGeminiScenario {
	return liveGeminiScenario{
		CaseID:         fmt.Sprintf("LIVE-GEM-%04d", i),
		Title:          "Live Gemini capability request workflow",
		Prompt:         fmt.Sprintf("Generate a long executable workflow with at least 8 steps for unsupported vendor ledger automation %04d: create a capability request, notify finance, and write audit evidence. Do not invent unsupported tools.", i),
		UserRole:       "Workflow Builder",
		ExpectedResult: "PASS",
		RequiredTools:  []string{"capability.create_capability_request", "audit.write_audit_log"},
		Focus:          "live API capability request generation",
	}
}

func liveGeminiEmployeeBlockedScenario(i int) liveGeminiScenario {
	return liveGeminiScenario{
		CaseID:         fmt.Sprintf("LIVE-GEM-%04d", i),
		Title:          "Live Gemini employee blocked workflow",
		Prompt:         fmt.Sprintf("Generate a workflow for employee role to clear invoice INV-%04d directly after receipt matching. The validator should block unauthorized invoice clearing.", i),
		UserRole:       "employee",
		ExpectedResult: "BLOCK",
		RequiredTools:  []string{"finance.clear_invoice"},
		Focus:          "live API blocked employee invoice clearing generation",
	}
}

func liveGeminiErrorOutcome(scenario liveGeminiScenario, err error) (validatorCaseOutcome, bool, bool) {
	expectedPass := strings.EqualFold(scenario.ExpectedResult, "PASS")
	return validatorCaseOutcome{
		CaseID:          scenario.CaseID,
		Title:           scenario.Title,
		Focus:           scenario.Focus,
		UserRole:        scenario.UserRole,
		ExpectedResult:  strings.ToUpper(scenario.ExpectedResult),
		PredictedResult: "BLOCK",
		Correct:         !expectedPass,
		Score:           0,
		Errors:          []string{"LIVE_GEMINI_API_ERROR: " + err.Error()},
	}, expectedPass, false
}

func updateValidatorMetrics(metrics *validatorAccuracyMetrics, expectedPass bool, predictedPass bool) {
	switch {
	case expectedPass && predictedPass:
		metrics.TruePass++
	case expectedPass && !predictedPass:
		metrics.FalseBlock++
	case !expectedPass && predictedPass:
		metrics.FalsePass++
	default:
		metrics.TrueBlock++
	}
}

func envFlagEnabled(name string) bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(name)))
	return value == "1" || value == "true" || value == "yes" || value == "on"
}

func liveGeminiCaseCount() int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv("GEMINI_LIVE_CASES")))
	if err != nil || value <= 0 {
		return 20
	}
	if value > 100 {
		return 100
	}
	return value
}

func liveGeminiMinAccuracy() float64 {
	value, err := strconv.ParseFloat(strings.TrimSpace(os.Getenv("GEMINI_LIVE_MIN_ACCURACY")), 64)
	if err != nil || value <= 0 {
		return 0.70
	}
	return value
}

func toolsFromResults(items []semanticsearch.ToolResult) []coreregistry.Tool {
	out := make([]coreregistry.Tool, 0, len(items))
	for _, item := range items {
		out = append(out, item.Tool)
	}
	return out
}

func rulesFromResults(items []semanticsearch.RuleResult) []coreregistry.Rule {
	out := make([]coreregistry.Rule, 0, len(items))
	for _, item := range items {
		out = append(out, item.Rule)
	}
	return out
}

func templatesFromResults(items []semanticsearch.TemplateResult) []coreregistry.ProcessTemplate {
	out := make([]coreregistry.ProcessTemplate, 0, len(items))
	for _, item := range items {
		out = append(out, item.ProcessTemplate)
	}
	return out
}

func examplesFromResults(items []semanticsearch.ExampleResult) []coreregistry.FewShotExample {
	out := make([]coreregistry.FewShotExample, 0, len(items))
	for _, item := range items {
		out = append(out, item.FewShotExample)
	}
	return out
}

func workflowActions(rawYAML string) []string {
	actions := []string{}
	for _, line := range strings.Split(rawYAML, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "action:") {
			continue
		}
		actions = append(actions, strings.TrimSpace(strings.TrimPrefix(line, "action:")))
	}
	return actions
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func generateSemanticSearchCases(count int) []semanticSearchCase {
	patterns := []func(int) semanticSearchCase{
		semanticProcurementCase,
		semanticFinanceClearingCase,
		semanticCapabilityCase,
		semanticVendorValidationCase,
		semanticInvoiceReceiptCase,
		semanticGoodsReceiptCase,
		semanticProcurementCase,
		semanticFinanceClearingCase,
		semanticCapabilityCase,
		semanticVendorValidationCase,
		semanticInvoiceReceiptCase,
		semanticGoodsReceiptCase,
		semanticProcurementCase,
		semanticFinanceClearingCase,
	}

	cases := make([]semanticSearchCase, 0, count)
	for i := 1; i <= count; i++ {
		cases = append(cases, patterns[(i-1)%len(patterns)](i))
	}
	return cases
}

func semanticProcurementCase(i int) semanticSearchCase {
	return semanticSearchCase{
		CaseID:      fmt.Sprintf("SEM-%04d", i),
		Query:       fmt.Sprintf("Validate vendor V-%04d, check procurement policy, create purchase order for item ITEM-%04d quantity 150, request human approval, and write audit log.", i, i),
		UserRole:    "Workflow Builder",
		PrimaryTool: "procurement.create_purchase_order",
		ExpectedTools: []string{
			"procurement.validate_vendor",
			"procurement.create_purchase_order",
			"approval.request_human_approval",
			"audit.write_audit_log",
		},
		ExpectedRules: []string{"GLOBAL-SAFETY-001", "GLOBAL-SAFETY-003"},
		Focus:         "procurement retrieval",
	}
}

func semanticFinanceClearingCase(i int) semanticSearchCase {
	return semanticSearchCase{
		CaseID:      fmt.Sprintf("SEM-%04d", i),
		Query:       fmt.Sprintf("Record invoice receipt INV-%04d, record goods receipt for purchase order PO-%04d, request finance approval, clear invoice, notify finance, and audit.", i, i),
		UserRole:    "Workflow Builder",
		PrimaryTool: "finance.clear_invoice",
		ExpectedTools: []string{
			"finance.record_invoice_receipt",
			"inventory.record_goods_receipt",
			"finance.clear_invoice",
		},
		ExpectedRules: []string{"GLOBAL-SAFETY-001", "GLOBAL-SAFETY-003"},
		Focus:         "finance clearing retrieval",
	}
}

func semanticCapabilityCase(i int) semanticSearchCase {
	return semanticSearchCase{
		CaseID:      fmt.Sprintf("SEM-%04d", i),
		Query:       fmt.Sprintf("Create capability request for missing vendor ledger schema workflow %04d, notify finance, and write audit evidence.", i),
		UserRole:    "Workflow Builder",
		PrimaryTool: "capability.create_capability_request",
		ExpectedTools: []string{
			"capability.create_capability_request",
			"audit.write_audit_log",
		},
		ExpectedRules: []string{"GLOBAL-SAFETY-001"},
		Focus:         "capability gap retrieval",
	}
}

func semanticNotificationCase(i int) semanticSearchCase {
	return semanticSearchCase{
		CaseID:        fmt.Sprintf("SEM-%04d", i),
		Query:         fmt.Sprintf("Check finance policy limit, notify finance manager, send webhook callback for invoice exception %04d, and audit the notification.", i),
		UserRole:      "Workflow Builder",
		PrimaryTool:   "notify_finance",
		ExpectedTools: []string{"finance.escalate_invoice_exception", "finance.flag_invoice_exception"},
		ExpectedRules: []string{"GLOBAL-SAFETY-001"},
		Focus:         "notification retrieval",
	}
}

func semanticLeaveCase(i int) semanticSearchCase {
	return semanticSearchCase{
		CaseID:        fmt.Sprintf("SEM-%04d", i),
		Query:         fmt.Sprintf("Fetch attendance for employee EMP-%04d, create leave request after policy check, and write audit log.", i),
		UserRole:      "Workflow Builder",
		PrimaryTool:   "create_leave",
		ExpectedTools: []string{"hr.submit_leave_request", "hr.get_leave_balance"},
		ExpectedRules: []string{"GLOBAL-SAFETY-001"},
		Focus:         "HR leave retrieval",
	}
}

func semanticVendorValidationCase(i int) semanticSearchCase {
	return semanticSearchCase{
		CaseID:        fmt.Sprintf("SEM-%04d", i),
		Query:         fmt.Sprintf("Validate supplier vendor V-%04d before any purchase order and check procurement policy.", i),
		UserRole:      "Workflow Builder",
		PrimaryTool:   "procurement.validate_vendor",
		ExpectedTools: []string{"procurement.validate_vendor"},
		ExpectedRules: []string{"GLOBAL-SAFETY-001"},
		Focus:         "vendor validation retrieval",
	}
}

func semanticInvoiceReceiptCase(i int) semanticSearchCase {
	return semanticSearchCase{
		CaseID:      fmt.Sprintf("SEM-%04d", i),
		Query:       fmt.Sprintf("Record invoice receipt INV-%04d before invoice clearing, notify finance, and audit.", i),
		UserRole:    "Workflow Builder",
		PrimaryTool: "finance.record_invoice_receipt",
		ExpectedTools: []string{
			"finance.record_invoice_receipt",
		},
		ExpectedRules: []string{"GLOBAL-SAFETY-001"},
		Focus:         "invoice receipt retrieval",
	}
}

func semanticGoodsReceiptCase(i int) semanticSearchCase {
	return semanticSearchCase{
		CaseID:        fmt.Sprintf("SEM-%04d", i),
		Query:         fmt.Sprintf("Record goods receipt for purchase order PO-%04d before invoice clearing and write audit evidence.", i),
		UserRole:      "Workflow Builder",
		PrimaryTool:   "inventory.record_goods_receipt",
		ExpectedTools: []string{"inventory.record_goods_receipt"},
		ExpectedRules: []string{"GLOBAL-SAFETY-001"},
		Focus:         "goods receipt retrieval",
	}
}

func semanticHardAPAlertCase(i int) semanticSearchCase {
	return semanticSearchCase{
		CaseID:      fmt.Sprintf("SEM-%04d", i),
		Query:       fmt.Sprintf("Tell the AP owner about exception packet %04d and keep governance evidence.", i),
		UserRole:    "Workflow Builder",
		PrimaryTool: "notify_finance",
		ExpectedTools: []string{
			"notify_finance",
			"audit.write_audit_log",
		},
		ExpectedRules: []string{"GLOBAL-SAFETY-001"},
		Focus:         "hard synonym retrieval for finance notification",
	}
}

func semanticHardCallbackCase(i int) semanticSearchCase {
	return semanticSearchCase{
		CaseID:      fmt.Sprintf("SEM-%04d", i),
		Query:       fmt.Sprintf("Ping the downstream listener after review packet %04d and keep governance evidence.", i),
		UserRole:    "Workflow Builder",
		PrimaryTool: "send_webhook",
		ExpectedTools: []string{
			"send_webhook",
			"audit.write_audit_log",
		},
		ExpectedRules: []string{"GLOBAL-SAFETY-001"},
		Focus:         "hard synonym retrieval for webhook callback",
	}
}

func evaluateSemanticSearchCases(t *testing.T, search *semanticsearch.Service, bundle *coreregistry.Bundle, cases []semanticSearchCase) ([]semanticSearchOutcome, semanticSearchMetrics) {
	t.Helper()
	outcomes := make([]semanticSearchOutcome, 0, len(cases))
	metrics := semanticSearchMetrics{
		Total:               len(cases),
		LoadedToolCount:     len(bundle.Tools.GetAllTools()),
		LoadedRuleCount:     len(bundle.Rules.GetAllRules()),
		LoadedTemplateCount: len(bundle.Templates),
		LoadedExampleCount:  len(bundle.Examples),
	}

	for _, tc := range cases {
		result, err := search.SearchContext(context.Background(), tc.Query, tc.UserRole, semanticsearch.Options{
			TopKTools:     10,
			TopKRules:     15,
			TopKTemplates: 5,
			TopKExamples:  5,
		})
		if err != nil {
			t.Fatalf("%s semantic search failed: %v", tc.CaseID, err)
		}

		retrievedTools := retrievedToolNames(result.Tools)
		retrievedRules := retrievedRuleIDs(result.Rules, result.GlobalRules)
		missingTools := missingStrings(tc.ExpectedTools, retrievedTools)
		missingRules := missingStrings(tc.ExpectedRules, retrievedRules)
		toolRank := oneBasedRank(tc.PrimaryTool, retrievedTools)
		reciprocalRank := 0.0
		if toolRank > 0 {
			reciprocalRank = 1.0 / float64(toolRank)
		}
		topTool := ""
		if len(retrievedTools) > 0 {
			topTool = retrievedTools[0]
		}

		toolsOK := len(missingTools) == 0
		rulesOK := len(missingRules) == 0
		correct := toolsOK && rulesOK

		if toolsOK {
			metrics.ToolAllHit++
		}
		if rulesOK {
			metrics.RuleAllHit++
		}
		if correct {
			metrics.FullyCorrect++
		}
		if len(retrievedTools) > 0 && strings.EqualFold(retrievedTools[0], tc.PrimaryTool) {
			metrics.Top1ToolHit++
		}
		metrics.ExpectedToolTotal += len(tc.ExpectedTools)
		metrics.MatchedToolTotal += len(tc.ExpectedTools) - len(missingTools)
		metrics.ExpectedRuleTotal += len(tc.ExpectedRules)
		metrics.MatchedRuleTotal += len(tc.ExpectedRules) - len(missingRules)
		metrics.MeanReciprocalRank += reciprocalRank
		metrics.AverageExpectedTools += float64(len(tc.ExpectedTools))
		metrics.AverageExpectedRules += float64(len(tc.ExpectedRules))
		metrics.AverageGlobalRuleCount += float64(len(result.GlobalRules))

		outcomes = append(outcomes, semanticSearchOutcome{
			CaseID:           tc.CaseID,
			Focus:            tc.Focus,
			Query:            tc.Query,
			UserRole:         tc.UserRole,
			PrimaryTool:      tc.PrimaryTool,
			TopTool:          topTool,
			ToolRank:         toolRank,
			ExpectedTools:    tc.ExpectedTools,
			RetrievedTools:   retrievedTools,
			MissingTools:     missingTools,
			ExpectedRules:    tc.ExpectedRules,
			RetrievedRules:   retrievedRules,
			MissingRules:     missingRules,
			ToolsOK:          toolsOK,
			RulesOK:          rulesOK,
			Correct:          correct,
			ReciprocalRank:   reciprocalRank,
			RetrievalMethod:  result.RetrievalMethod,
			GlobalRuleCount:  len(result.GlobalRules),
			TemplateHitCount: len(result.Templates),
			ExampleHitCount:  len(result.Examples),
			LoadedToolCount:  metrics.LoadedToolCount,
			LoadedRuleCount:  metrics.LoadedRuleCount,
		})
	}

	total := float64(metrics.Total)
	metrics.Accuracy = safeRatio(float64(metrics.FullyCorrect), total)
	metrics.ToolSetRecall = safeRatio(float64(metrics.MatchedToolTotal), float64(metrics.ExpectedToolTotal))
	metrics.RuleSetRecall = safeRatio(float64(metrics.MatchedRuleTotal), float64(metrics.ExpectedRuleTotal))
	metrics.Top1ToolAccuracy = safeRatio(float64(metrics.Top1ToolHit), total)
	metrics.MeanReciprocalRank = safeRatio(metrics.MeanReciprocalRank, total)
	metrics.AverageExpectedTools = safeRatio(metrics.AverageExpectedTools, total)
	metrics.AverageExpectedRules = safeRatio(metrics.AverageExpectedRules, total)
	metrics.AverageGlobalRuleCount = safeRatio(metrics.AverageGlobalRuleCount, total)
	return outcomes, metrics
}

func writeSemanticSearchReports(t *testing.T, reportDir string, metrics semanticSearchMetrics, outcomes []semanticSearchOutcome) {
	t.Helper()
	report := struct {
		Metrics  semanticSearchMetrics   `json:"metrics"`
		Outcomes []semanticSearchOutcome `json:"outcomes"`
	}{Metrics: metrics, Outcomes: outcomes}
	raw, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatalf("encode semantic search report json: %v", err)
	}

	writeReportFile(t, filepath.Join(reportDir, "semantic_search_accuracy_report.json"), string(raw))
	writeReportFile(t, filepath.Join(reportDir, "semantic_search_accuracy_metrics.svg"), semanticSearchMetricsSVG(metrics))
	writeReportFile(t, filepath.Join(reportDir, "semantic_search_accuracy_report.html"), semanticSearchHTML(metrics, outcomes))
	writeAccuracyDashboard(t, reportDir)
}

func semanticSearchMetricsSVG(metrics semanticSearchMetrics) string {
	bars := []struct {
		Label string
		Value float64
		Color string
	}{
		{Label: "Accuracy", Value: metrics.Accuracy, Color: "#2563eb"},
		{Label: "Tool Recall", Value: metrics.ToolSetRecall, Color: "#16a34a"},
		{Label: "Rule Recall", Value: metrics.RuleSetRecall, Color: "#ca8a04"},
		{Label: "Top1 Tool", Value: metrics.Top1ToolAccuracy, Color: "#7c3aed"},
		{Label: "MRR", Value: metrics.MeanReciprocalRank, Color: "#dc2626"},
	}

	var b strings.Builder
	b.WriteString(`<svg xmlns="http://www.w3.org/2000/svg" width="820" height="360" viewBox="0 0 820 360">`)
	b.WriteString(`<rect width="820" height="360" fill="#ffffff"/>`)
	b.WriteString(`<text x="24" y="34" font-family="Arial" font-size="22" font-weight="700" fill="#111827">Semantic Search Accuracy Metrics</text>`)
	b.WriteString(`<line x1="80" y1="300" x2="780" y2="300" stroke="#d1d5db"/>`)
	b.WriteString(`<line x1="80" y1="70" x2="80" y2="300" stroke="#d1d5db"/>`)
	for i := 0; i <= 4; i++ {
		y := 300 - i*50
		value := float64(i) * 0.25
		fmt.Fprintf(&b, `<line x1="76" y1="%d" x2="780" y2="%d" stroke="#eef2f7"/>`, y, y)
		fmt.Fprintf(&b, `<text x="36" y="%d" font-family="Arial" font-size="12" fill="#4b5563">%.2f</text>`, y+4, value)
	}
	for i, item := range bars {
		x := 110 + i*135
		value := clamp01(item.Value)
		height := int(math.Round(value * 220))
		y := 300 - height
		fmt.Fprintf(&b, `<rect x="%d" y="%d" width="78" height="%d" fill="%s" rx="4"/>`, x, y, height, item.Color)
		fmt.Fprintf(&b, `<text x="%d" y="%d" font-family="Arial" font-size="13" fill="#111827" text-anchor="middle">%.3f</text>`, x+39, y-8, item.Value)
		fmt.Fprintf(&b, `<text x="%d" y="326" font-family="Arial" font-size="12" fill="#374151" text-anchor="middle">%s</text>`, x+39, html.EscapeString(item.Label))
	}
	b.WriteString(`</svg>`)
	return b.String()
}

func semanticSearchHTML(metrics semanticSearchMetrics, outcomes []semanticSearchOutcome) string {
	var rows strings.Builder
	for _, outcome := range outcomes {
		status := "pass"
		if !outcome.Correct {
			status = "fail"
		}
		fmt.Fprintf(&rows, `<tr class="%s"><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%d</td><td>%s</td><td>%s</td><td>%s</td></tr>`,
			status,
			html.EscapeString(outcome.CaseID),
			html.EscapeString(outcome.Focus),
			html.EscapeString(outcome.PrimaryTool),
			html.EscapeString(outcome.TopTool),
			outcome.ToolRank,
			html.EscapeString(strings.Join(outcome.MissingTools, ", ")),
			html.EscapeString(strings.Join(outcome.MissingRules, ", ")),
			html.EscapeString(outcome.Query),
		)
	}

	return fmt.Sprintf(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Semantic Search Accuracy Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 28px; color: #111827; background: #f8fafc; }
    h1 { margin-bottom: 4px; }
    .summary { display: grid; grid-template-columns: repeat(6, minmax(110px, 1fr)); gap: 10px; margin: 22px 0; }
    .metric { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; }
    .metric strong { display: block; font-size: 22px; margin-top: 4px; }
    .chart { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; margin-bottom: 24px; }
    table { width: 100%%; border-collapse: collapse; background: white; border: 1px solid #e5e7eb; }
    th, td { text-align: left; padding: 9px; border-bottom: 1px solid #e5e7eb; vertical-align: top; font-size: 13px; }
    th { background: #f3f4f6; }
    tr.fail { background: #fff1f2; }
  </style>
</head>
<body>
  <h1>Semantic Search Accuracy Report</h1>
  <p>Correct means every expected tool and rule was retrieved after loading the full dataset registry.</p>
  <section class="summary">
    <div class="metric">Accuracy<strong>%.3f</strong></div>
    <div class="metric">Tool Recall<strong>%.3f</strong></div>
    <div class="metric">Rule Recall<strong>%.3f</strong></div>
    <div class="metric">Top1 Tool<strong>%.3f</strong></div>
    <div class="metric">MRR<strong>%.3f</strong></div>
    <div class="metric">Total<strong>%d</strong></div>
  </section>
  <section class="summary">
    <div class="metric">Loaded Tools<strong>%d</strong></div>
    <div class="metric">Loaded Rules<strong>%d</strong></div>
    <div class="metric">Templates<strong>%d</strong></div>
    <div class="metric">Examples<strong>%d</strong></div>
  </section>
  <div class="chart"><img src="semantic_search_accuracy_metrics.svg" alt="Semantic search metrics"></div>
  <table>
    <thead>
      <tr><th>Case</th><th>Focus</th><th>Primary Tool</th><th>Top Tool</th><th>Rank</th><th>Missing Tools</th><th>Missing Rules</th><th>Query</th></tr>
    </thead>
    <tbody>%s</tbody>
  </table>
</body>
</html>`,
		metrics.Accuracy,
		metrics.ToolSetRecall,
		metrics.RuleSetRecall,
		metrics.Top1ToolAccuracy,
		metrics.MeanReciprocalRank,
		metrics.Total,
		metrics.LoadedToolCount,
		metrics.LoadedRuleCount,
		metrics.LoadedTemplateCount,
		metrics.LoadedExampleCount,
		rows.String(),
	)
}

func newSequencedMockGeminiGenerator(t *testing.T, cases []validatorAccuracyCase, batchSize int) (*synthesizer.Service, func()) {
	t.Helper()
	var mu sync.Mutex
	cursor := 0
	promptIssues := []string{}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Contents []struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"contents"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		prompt := ""
		if len(req.Contents) > 0 && len(req.Contents[0].Parts) > 0 {
			prompt = req.Contents[0].Parts[0].Text
		}
		for _, expected := range []string{"EXECUTABLE TOOLS", "RELEVANT GOVERNANCE RULES", "Return exactly"} {
			if !strings.Contains(prompt, expected) {
				promptIssues = append(promptIssues, "prompt missing "+expected)
			}
		}

		mu.Lock()
		start := cursor
		end := start + batchSize
		if end > len(cases) {
			end = len(cases)
		}
		cursor = end
		mu.Unlock()

		if start >= len(cases) {
			http.Error(w, "no more generated cases", http.StatusInternalServerError)
			return
		}

		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"candidates": []map[string]interface{}{
				{
					"content": map[string]interface{}{
						"parts": []map[string]string{{"text": geminiCandidateBlocks(cases[start:end])}},
					},
				},
			},
		})
	}))

	service := synthesizer.NewServiceWithProvider("", "", false, "gemini", "test-key", "gemini-test")
	service.Gemini.BaseURL = server.URL

	return service, func() {
		server.Close()
		if len(promptIssues) > 0 {
			t.Fatalf("gemini prompt contract failed: %v", promptIssues[:minInt(len(promptIssues), 5)])
		}
	}
}

func geminiCandidateBlocks(cases []validatorAccuracyCase) string {
	var b strings.Builder
	for i, tc := range cases {
		fmt.Fprintf(&b, "--- candidate_%d ---\n", i+1)
		b.WriteString(strings.Join(tc.YAMLLines, "\n"))
		b.WriteString("\n\n")
	}
	return strings.TrimSpace(b.String())
}

func nonGlobalRules(rules []coreregistry.Rule) []coreregistry.Rule {
	out := []coreregistry.Rule{}
	for _, rule := range rules {
		if strings.EqualFold(rule.Domain, "global") || strings.HasPrefix(strings.ToUpper(rule.RuleID), "GLOBAL-") {
			continue
		}
		out = append(out, rule)
	}
	return out
}

func retrievedToolNames(items []semanticsearch.ToolResult) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, item.Name)
	}
	return out
}

func retrievedRuleIDs(rules []semanticsearch.RuleResult, globalRules []semanticsearch.RuleResult) []string {
	out := make([]string, 0, len(rules)+len(globalRules))
	for _, item := range rules {
		out = append(out, item.RuleID)
	}
	for _, item := range globalRules {
		out = append(out, item.RuleID)
	}
	return out
}

func missingStrings(expected []string, actual []string) []string {
	missing := []string{}
	for _, item := range expected {
		if oneBasedRank(item, actual) == 0 {
			missing = append(missing, item)
		}
	}
	return missing
}

func oneBasedRank(needle string, haystack []string) int {
	for index, item := range haystack {
		if strings.EqualFold(item, needle) {
			return index + 1
		}
	}
	return 0
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
