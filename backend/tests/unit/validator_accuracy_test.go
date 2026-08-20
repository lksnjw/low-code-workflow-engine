package unit

import (
	"encoding/json"
	"fmt"
	"html"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

const minGeneratedLongFlowSteps = 8

type validatorAccuracyCase struct {
	CaseID                string   `json:"case_id"`
	Title                 string   `json:"title"`
	UserRole              string   `json:"user_role"`
	ExpectedResult        string   `json:"expected_result"`
	ExpectedFailedRules   []string `json:"expected_failed_rules"`
	ExpectedErrorContains []string `json:"expected_error_contains"`
	Focus                 string   `json:"focus"`
	YAMLLines             []string `json:"yaml_lines"`
}

type validatorCaseOutcome struct {
	CaseID          string   `json:"case_id"`
	Title           string   `json:"title"`
	Focus           string   `json:"focus"`
	UserRole        string   `json:"user_role"`
	ExpectedResult  string   `json:"expected_result"`
	PredictedResult string   `json:"predicted_result"`
	Correct         bool     `json:"correct"`
	Score           float64  `json:"score"`
	FailedRules     []string `json:"failed_rules"`
	Errors          []string `json:"errors"`
}

type validatorAccuracyMetrics struct {
	Total       int     `json:"total"`
	TruePass    int     `json:"true_pass"`
	TrueBlock   int     `json:"true_block"`
	FalsePass   int     `json:"false_pass"`
	FalseBlock  int     `json:"false_block"`
	Accuracy    float64 `json:"accuracy"`
	Precision   float64 `json:"precision"`
	Recall      float64 `json:"recall"`
	Specificity float64 `json:"specificity"`
	F1          float64 `json:"f1_score"`
	MCC         float64 `json:"mcc"`
}

func TestRegistryValidatorAccuracyReport(t *testing.T) {
	cases := loadValidatorAccuracyCases(t)
	if len(cases) == 0 {
		t.Fatal("expected validator accuracy cases")
	}

	validator := newImplementedRuleRegistryValidator(t)
	outcomes, metrics := evaluateValidatorCases(t, validator, cases, true)
	reportDir := filepath.Join(repoRootFromTest(t), "test-results")
	writeValidatorReports(t, reportDir, metrics, outcomes)

	t.Logf("validator accuracy report: %s", filepath.Join(reportDir, "validator_accuracy_report.html"))
	t.Logf("validator metrics: accuracy=%.3f precision=%.3f recall=%.3f specificity=%.3f f1=%.3f mcc=%.3f",
		metrics.Accuracy, metrics.Precision, metrics.Recall, metrics.Specificity, metrics.F1, metrics.MCC)
	t.Logf("\n%s", validatorMetricTextChart(metrics))

	if metrics.Accuracy < 0.95 || metrics.F1 < 0.95 || metrics.MCC < 0.90 {
		t.Fatalf("validator metrics below acceptance threshold: %+v", metrics)
	}
}

func TestRegistryValidatorGeneratedLongFlowAccuracyReport(t *testing.T) {
	const generatedFlowCount = 5000

	cases := generateLongValidatorAccuracyCases(generatedFlowCount)
	if len(cases) != generatedFlowCount {
		t.Fatalf("expected %d generated flows, got %d", generatedFlowCount, len(cases))
	}
	for _, tc := range cases {
		if stepCount := countWorkflowActionLines(tc.YAMLLines); stepCount < minGeneratedLongFlowSteps {
			t.Fatalf("%s expected a long flow with at least %d steps, got %d", tc.CaseID, minGeneratedLongFlowSteps, stepCount)
		}
	}

	validator := newImplementedRuleRegistryValidator(t)
	outcomes, metrics := evaluateValidatorCases(t, validator, cases, false)
	reportDir := filepath.Join(repoRootFromTest(t), "test-results")

	writeValidatorReportsNamed(t, reportDir, "validator_generated_5000", "Validator Generated 5000 Flow Accuracy Report", metrics, outcomes)
	writeValidatorFlowDataset(t, filepath.Join(reportDir, "validator_generated_5000_flows.jsonl"), cases)

	t.Logf("generated flow dataset: %s", filepath.Join(reportDir, "validator_generated_5000_flows.jsonl"))
	t.Logf("generated validator accuracy report: %s", filepath.Join(reportDir, "validator_generated_5000_report.html"))
	t.Logf("generated validator metrics: total=%d accuracy=%.3f precision=%.3f recall=%.3f specificity=%.3f f1=%.3f mcc=%.3f",
		metrics.Total, metrics.Accuracy, metrics.Precision, metrics.Recall, metrics.Specificity, metrics.F1, metrics.MCC)
	t.Logf("\n%s", validatorMetricTextChart(metrics))

	if metrics.Accuracy < 0.85 || metrics.F1 < 0.85 || metrics.MCC < 0.75 {
		t.Fatalf("generated validator metrics below acceptance threshold: %+v", metrics)
	}
}

func loadValidatorAccuracyCases(t *testing.T) []validatorAccuracyCase {
	t.Helper()
	path := filepath.Join(repoRootFromTest(t), "tests", "fixtures", "validator_accuracy_cases.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read validator accuracy fixture: %v", err)
	}
	var cases []validatorAccuracyCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatalf("decode validator accuracy fixture: %v", err)
	}
	return cases
}

// Accuracy reports measure families with real deterministic evaluators. The
// separate fail-closed tests cover enabled NO_EVALUATOR families explicitly;
// including them here would turn every labeled safe case into the same
// configuration-gap block instead of measuring evaluator accuracy.
func newImplementedRuleRegistryValidator(t *testing.T) *workflowvalidator.RegistryValidator {
	t.Helper()
	bundle := loadRegistryFixture(t)
	rules := []coreregistry.Rule{}
	for _, rule := range bundle.Rules.GetAllRules() {
		if workflowvalidator.ClassifyRuleFamily(rule.RuleType) == workflowvalidator.RuleFamilyEvaluated {
			rules = append(rules, rule)
		}
	}
	return workflowvalidator.NewRegistryValidator(
		bundle.Tools,
		coreregistry.NewRuleRegistry(rules, bundle.Rules.Version()+"-implemented-only"),
		repository.NewStore(),
	)
}

func evaluateValidatorCases(t *testing.T, validator *workflowvalidator.RegistryValidator, cases []validatorAccuracyCase, strictExpectations bool) ([]validatorCaseOutcome, validatorAccuracyMetrics) {
	t.Helper()
	outcomes := make([]validatorCaseOutcome, 0, len(cases))
	metrics := validatorAccuracyMetrics{Total: len(cases)}

	for _, tc := range cases {
		yamlText := strings.Join(tc.YAMLLines, "\n") + "\n"
		result := validator.ValidateCandidate(tc.CaseID, yamlText, tc.UserRole)
		expectedPass := strings.EqualFold(tc.ExpectedResult, "PASS")
		predictedPass := result.Passed
		predictedResult := "BLOCK"
		if predictedPass {
			predictedResult = "PASS"
		}

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

		outcome := validatorCaseOutcome{
			CaseID:          tc.CaseID,
			Title:           tc.Title,
			Focus:           tc.Focus,
			UserRole:        tc.UserRole,
			ExpectedResult:  strings.ToUpper(tc.ExpectedResult),
			PredictedResult: predictedResult,
			Correct:         expectedPass == predictedPass,
			Score:           result.Score,
			FailedRules:     result.FailedRules,
			Errors:          result.Errors,
		}
		outcomes = append(outcomes, outcome)

		if !strictExpectations {
			continue
		}
		if expectedPass != predictedPass {
			t.Errorf("%s expected %s, got %s; errors=%v failed_rules=%v", tc.CaseID, tc.ExpectedResult, predictedResult, result.Errors, result.FailedRules)
		}
		for _, ruleID := range tc.ExpectedFailedRules {
			if !hasFailedRule(result, ruleID) {
				t.Errorf("%s expected failed rule %s, got %v", tc.CaseID, ruleID, result.FailedRules)
			}
		}
		for _, expectedText := range tc.ExpectedErrorContains {
			if !containsAny(result.Errors, expectedText) {
				t.Errorf("%s expected error containing %q, got %v", tc.CaseID, expectedText, result.Errors)
			}
		}
		if expectedPass && len(result.Errors) > 0 {
			t.Errorf("%s expected no errors for pass case, got %v", tc.CaseID, result.Errors)
		}
	}

	return outcomes, finalizeValidatorMetrics(metrics)
}

func finalizeValidatorMetrics(metrics validatorAccuracyMetrics) validatorAccuracyMetrics {
	tp := float64(metrics.TruePass)
	tn := float64(metrics.TrueBlock)
	fp := float64(metrics.FalsePass)
	fn := float64(metrics.FalseBlock)
	total := tp + tn + fp + fn

	metrics.Accuracy = safeRatio(tp+tn, total)
	metrics.Precision = safeRatio(tp, tp+fp)
	metrics.Recall = safeRatio(tp, tp+fn)
	metrics.Specificity = safeRatio(tn, tn+fp)
	metrics.F1 = safeRatio(2*metrics.Precision*metrics.Recall, metrics.Precision+metrics.Recall)

	denominator := math.Sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn))
	metrics.MCC = safeRatio(tp*tn-fp*fn, denominator)
	return metrics
}

func writeValidatorReports(t *testing.T, reportDir string, metrics validatorAccuracyMetrics, outcomes []validatorCaseOutcome) {
	t.Helper()
	writeValidatorReportsNamed(t, reportDir, "validator_accuracy", "Validator Accuracy Report", metrics, outcomes)
}

func writeValidatorReportsNamed(t *testing.T, reportDir, prefix, title string, metrics validatorAccuracyMetrics, outcomes []validatorCaseOutcome) {
	t.Helper()
	if err := os.MkdirAll(reportDir, 0o755); err != nil {
		t.Fatalf("create validator report directory: %v", err)
	}

	report := struct {
		Metrics  validatorAccuracyMetrics `json:"metrics"`
		Outcomes []validatorCaseOutcome   `json:"outcomes"`
	}{Metrics: metrics, Outcomes: outcomes}
	raw, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatalf("encode validator report json: %v", err)
	}
	metricsSVG := prefix + "_metrics.svg"
	confusionSVG := prefix + "_confusion_matrix.svg"
	writeReportFile(t, filepath.Join(reportDir, prefix+"_report.json"), string(raw))
	writeReportFile(t, filepath.Join(reportDir, metricsSVG), validatorMetricsSVG(metrics))
	writeReportFile(t, filepath.Join(reportDir, confusionSVG), validatorConfusionMatrixSVG(metrics))
	writeReportFile(t, filepath.Join(reportDir, prefix+"_report.html"), validatorAccuracyHTML(title, metrics, outcomes, metricsSVG, confusionSVG))
	writeAccuracyDashboard(t, reportDir)
}

func writeReportFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write report file %s: %v", path, err)
	}
}

func validatorMetricsSVG(metrics validatorAccuracyMetrics) string {
	type bar struct {
		Label string
		Value float64
		Color string
	}
	bars := []bar{
		{Label: "Accuracy", Value: metrics.Accuracy, Color: "#2563eb"},
		{Label: "Precision", Value: metrics.Precision, Color: "#16a34a"},
		{Label: "Recall", Value: metrics.Recall, Color: "#ca8a04"},
		{Label: "F1", Value: metrics.F1, Color: "#7c3aed"},
		{Label: "MCC", Value: metrics.MCC, Color: "#dc2626"},
	}

	var b strings.Builder
	b.WriteString(`<svg xmlns="http://www.w3.org/2000/svg" width="760" height="360" viewBox="0 0 760 360">`)
	b.WriteString(`<rect width="760" height="360" fill="#ffffff"/>`)
	b.WriteString(`<text x="24" y="34" font-family="Arial" font-size="22" font-weight="700" fill="#111827">Validator Accuracy Metrics</text>`)
	b.WriteString(`<line x1="80" y1="300" x2="720" y2="300" stroke="#d1d5db"/>`)
	b.WriteString(`<line x1="80" y1="70" x2="80" y2="300" stroke="#d1d5db"/>`)
	for i := 0; i <= 4; i++ {
		y := 300 - i*50
		value := float64(i) * 0.25
		fmt.Fprintf(&b, `<line x1="76" y1="%d" x2="720" y2="%d" stroke="#eef2f7"/>`, y, y)
		fmt.Fprintf(&b, `<text x="36" y="%d" font-family="Arial" font-size="12" fill="#4b5563">%.2f</text>`, y+4, value)
	}
	for i, item := range bars {
		x := 110 + i*120
		value := clamp01(item.Value)
		height := int(math.Round(value * 220))
		y := 300 - height
		fmt.Fprintf(&b, `<rect x="%d" y="%d" width="70" height="%d" fill="%s" rx="4"/>`, x, y, height, item.Color)
		fmt.Fprintf(&b, `<text x="%d" y="%d" font-family="Arial" font-size="13" fill="#111827" text-anchor="middle">%.3f</text>`, x+35, y-8, item.Value)
		fmt.Fprintf(&b, `<text x="%d" y="326" font-family="Arial" font-size="13" fill="#374151" text-anchor="middle">%s</text>`, x+35, html.EscapeString(item.Label))
	}
	b.WriteString(`</svg>`)
	return b.String()
}

func validatorConfusionMatrixSVG(metrics validatorAccuracyMetrics) string {
	maxCount := maxInt(metrics.TruePass, metrics.TrueBlock, metrics.FalsePass, metrics.FalseBlock)
	cell := func(label string, value int, x int, y int, color string) string {
		opacity := 0.20 + 0.70*safeRatio(float64(value), float64(maxCount))
		return fmt.Sprintf(`<rect x="%d" y="%d" width="220" height="105" rx="6" fill="%s" opacity="%.2f"/>
<text x="%d" y="%d" font-family="Arial" font-size="16" font-weight="700" fill="#111827" text-anchor="middle">%s</text>
<text x="%d" y="%d" font-family="Arial" font-size="34" font-weight="700" fill="#111827" text-anchor="middle">%d</text>`,
			x, y, color, opacity, x+110, y+34, label, x+110, y+76, value)
	}

	var b strings.Builder
	b.WriteString(`<svg xmlns="http://www.w3.org/2000/svg" width="620" height="360" viewBox="0 0 620 360">`)
	b.WriteString(`<rect width="620" height="360" fill="#ffffff"/>`)
	b.WriteString(`<text x="24" y="34" font-family="Arial" font-size="22" font-weight="700" fill="#111827">Validator Confusion Matrix</text>`)
	b.WriteString(`<text x="220" y="70" font-family="Arial" font-size="13" fill="#374151" text-anchor="middle">Predicted PASS</text>`)
	b.WriteString(`<text x="460" y="70" font-family="Arial" font-size="13" fill="#374151" text-anchor="middle">Predicted BLOCK</text>`)
	b.WriteString(`<text x="38" y="142" font-family="Arial" font-size="13" fill="#374151" transform="rotate(-90 38 142)" text-anchor="middle">Expected PASS</text>`)
	b.WriteString(`<text x="38" y="266" font-family="Arial" font-size="13" fill="#374151" transform="rotate(-90 38 266)" text-anchor="middle">Expected BLOCK</text>`)
	b.WriteString(cell("True PASS", metrics.TruePass, 110, 90, "#22c55e"))
	b.WriteString(cell("False BLOCK", metrics.FalseBlock, 350, 90, "#f97316"))
	b.WriteString(cell("False PASS", metrics.FalsePass, 110, 220, "#ef4444"))
	b.WriteString(cell("True BLOCK", metrics.TrueBlock, 350, 220, "#3b82f6"))
	b.WriteString(`</svg>`)
	return b.String()
}

func validatorAccuracyHTML(title string, metrics validatorAccuracyMetrics, outcomes []validatorCaseOutcome, metricsSVG string, confusionSVG string) string {
	var rows strings.Builder
	for _, outcome := range outcomes {
		status := "pass"
		if !outcome.Correct {
			status = "fail"
		}
		fmt.Fprintf(&rows, `<tr class="%s"><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%.2f</td><td>%s</td><td>%s</td></tr>`,
			status,
			html.EscapeString(outcome.CaseID),
			html.EscapeString(outcome.Title),
			html.EscapeString(outcome.Focus),
			html.EscapeString(outcome.ExpectedResult),
			html.EscapeString(outcome.PredictedResult),
			outcome.Score,
			html.EscapeString(strings.Join(outcome.FailedRules, ", ")),
			html.EscapeString(strings.Join(outcome.Errors, " | ")),
		)
	}

	return fmt.Sprintf(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>%s</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 28px; color: #111827; background: #f8fafc; }
    h1 { margin-bottom: 4px; }
    .summary { display: grid; grid-template-columns: repeat(6, minmax(110px, 1fr)); gap: 10px; margin: 22px 0; }
    .metric { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; }
    .metric strong { display: block; font-size: 22px; margin-top: 4px; }
    .charts { display: grid; grid-template-columns: 1fr; gap: 16px; margin-bottom: 24px; }
    .chart { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; }
    table { width: 100%%; border-collapse: collapse; background: white; border: 1px solid #e5e7eb; }
    th, td { text-align: left; padding: 9px; border-bottom: 1px solid #e5e7eb; vertical-align: top; font-size: 13px; }
    th { background: #f3f4f6; }
    tr.fail { background: #fff1f2; }
  </style>
</head>
<body>
  <h1>%s</h1>
  <p>Positive class: validator predicts executable PASS.</p>
  <section class="summary">
    <div class="metric">Accuracy<strong>%.3f</strong></div>
    <div class="metric">Precision<strong>%.3f</strong></div>
    <div class="metric">Recall<strong>%.3f</strong></div>
    <div class="metric">Specificity<strong>%.3f</strong></div>
    <div class="metric">F1 Score<strong>%.3f</strong></div>
    <div class="metric">MCC<strong>%.3f</strong></div>
  </section>
  <section class="charts">
    <div class="chart"><img src="%s" alt="Metric bar chart"></div>
    <div class="chart"><img src="%s" alt="Confusion matrix"></div>
  </section>
  <table>
    <thead>
      <tr><th>Case</th><th>Title</th><th>Focus</th><th>Expected</th><th>Predicted</th><th>Score</th><th>Failed Rules</th><th>Errors</th></tr>
    </thead>
    <tbody>%s</tbody>
  </table>
</body>
</html>`,
		html.EscapeString(title),
		html.EscapeString(title),
		metrics.Accuracy,
		metrics.Precision,
		metrics.Recall,
		metrics.Specificity,
		metrics.F1,
		metrics.MCC,
		html.EscapeString(metricsSVG),
		html.EscapeString(confusionSVG),
		rows.String(),
	)
}

type validatorGeneratedStep struct {
	ID     string
	Action string
	Params []string
}

func generateLongValidatorAccuracyCases(count int) []validatorAccuracyCase {
	generators := []func(int) validatorAccuracyCase{
		generatePassReadOnlyLongFlow,
		generatePassLegacyWriteLongFlow,
		generatePassProcurementLongFlow,
		generatePassFinanceClearingLongFlow,
		generatePassCapabilityRequestLongFlow,
		generatePassMixedNotificationLongFlow,
		generatePassReadOnlyLongFlow,
		generatePassLegacyWriteLongFlow,
		generatePassProcurementLongFlow,
		generatePassFinanceClearingLongFlow,
		generatePassCapabilityRequestLongFlow,
		generateBlockUnknownToolLongFlow,
		generateBlockMissingParameterLongFlow,
		generateBlockProcurementOrderLongFlow,
		generateBlockMissingApprovalLongFlow,
		generateBlockMissingAuditLongFlow,
		generateBlockSecretLongFlow,
		generateBlockFinanceOrderLongFlow,
		generateBlockEmployeeInvoiceClearLongFlow,
		generateBlockInactiveVendorSemanticGapLongFlow,
	}

	cases := make([]validatorAccuracyCase, 0, count)
	for i := 1; i <= count; i++ {
		cases = append(cases, generators[(i-1)%len(generators)](i))
	}
	return cases
}

func generatePassReadOnlyLongFlow(i int) validatorAccuracyCase {
	prefix := fmt.Sprintf("gen_%04d", i)
	steps := []validatorGeneratedStep{}
	steps = append(steps, readOnlyPrelude(prefix, i)...)
	steps = append(steps,
		generatedStep(prefix+"_policy_extra_1", "policy.check_policy_limit", "policy_domain: finance", fmt.Sprintf("amount: %d", 20000+i), "currency: LKR"),
		generatedStep(prefix+"_classify_extra_1", "classify_invoice", fmt.Sprintf("invoiceId: INV-%04d-A", i)),
		generatedStep(prefix+"_policy_extra_2", "policy_check", "intent: readonly_preflight", fmt.Sprintf("quantity: %d", 5+i%20)),
		generatedStep(prefix+"_classify_extra_2", "classify_invoice", fmt.Sprintf("invoiceId: INV-%04d-B", i)),
	)
	return generatedCase(i, "PASS", "read-only valid long flow", "Read-only checks do not need audit or approval.", "Workflow Builder", steps)
}

func generatePassLegacyWriteLongFlow(i int) validatorAccuracyCase {
	prefix := fmt.Sprintf("gen_%04d", i)
	steps := append([]validatorGeneratedStep{}, readOnlyPrelude(prefix, i)...)
	steps = append(steps,
		generatedStep(prefix+"_create_leave", "create_leave", fmt.Sprintf("employeeId: EMP-%04d", i), "start_date: 2026-06-01", "end_date: 2026-06-03", "leave_type: annual"),
		generatedStep(prefix+"_refresh_connector", "refresh_connector", fmt.Sprintf("connector_id: ERP-CONN-%03d", i%50)),
		generatedStep(prefix+"_notify_finance", "notify_finance", fmt.Sprintf("message: Workflow %04d completed policy-safe writes", i), "recipient_id: FIN-OPS"),
		generatedStep(prefix+"_send_webhook", "send_webhook", fmt.Sprintf("url: \"https://example.test/hooks/%04d\"", i), fmt.Sprintf("payload: workflow_%04d", i)),
		generatedStep(prefix+"_audit", "audit.write_audit_log", "event_type: legacy_write_workflow", "actor_role: Workflow Builder", "decision: queued"),
	)
	return generatedCase(i, "PASS", "legacy write valid long flow", "Medium-risk write actions include a final audit log.", "Workflow Builder", steps)
}

func generatePassProcurementLongFlow(i int) validatorAccuracyCase {
	prefix := fmt.Sprintf("gen_%04d", i)
	quantity := 120 + i%90
	steps := append([]validatorGeneratedStep{}, readOnlyPrelude(prefix, i)...)
	steps = append(steps,
		generatedStep(prefix+"_validate_vendor", "procurement.validate_vendor", fmt.Sprintf("vendor_id: V-%04d", i)),
		generatedStep(prefix+"_proc_policy", "policy.check_policy_limit", "policy_domain: procurement", fmt.Sprintf("quantity: %d", quantity), "currency: LKR"),
		generatedStep(prefix+"_approval", "approval.request_human_approval", "approval_reason: High-risk purchase order", "approver_role: procurement_manager", fmt.Sprintf("quantity: %d", quantity)),
		generatedStep(prefix+"_create_po", "procurement.create_purchase_order", fmt.Sprintf("vendor_id: V-%04d", i), fmt.Sprintf("item_id: ITEM-%04d", i), fmt.Sprintf("quantity: %d", quantity), "currency: LKR"),
		generatedStep(prefix+"_notify_finance", "notify_finance", fmt.Sprintf("message: Purchase order workflow %04d queued", i)),
		generatedStep(prefix+"_audit", "audit.write_audit_log", "event_type: purchase_order_created", "actor_role: Workflow Builder", "decision: approved_for_execution"),
	)
	return generatedCase(i, "PASS", "procurement valid long flow", "Vendor validation, approval, and audit satisfy procurement rules.", "Workflow Builder", steps)
}

func generatePassFinanceClearingLongFlow(i int) validatorAccuracyCase {
	prefix := fmt.Sprintf("gen_%04d", i)
	steps := append([]validatorGeneratedStep{}, readOnlyPrelude(prefix, i)...)
	steps = append(steps,
		generatedStep(prefix+"_invoice_receipt", "finance.record_invoice_receipt", fmt.Sprintf("invoice_id: INV-%04d", i), fmt.Sprintf("receipt_reference: RR-%04d", i)),
		generatedStep(prefix+"_goods_receipt", "inventory.record_goods_receipt", fmt.Sprintf("purchase_order_id: PO-%04d", i), fmt.Sprintf("received_quantity: %d", 10+i%30), fmt.Sprintf("item_id: ITEM-%04d", i)),
		generatedStep(prefix+"_approval", "approval.request_human_approval", "approval_reason: Critical invoice clearing", "approver_role: finance_manager", fmt.Sprintf("workflow_id: WF-%04d", i)),
		generatedStep(prefix+"_clear_invoice", "finance.clear_invoice", fmt.Sprintf("invoice_id: INV-%04d", i), fmt.Sprintf("purchase_order_id: PO-%04d", i), fmt.Sprintf("goods_receipt_id: GR-%04d", i)),
		generatedStep(prefix+"_notify_finance", "notify_finance", fmt.Sprintf("message: Invoice INV-%04d cleared after receipts", i)),
		generatedStep(prefix+"_audit", "audit.write_audit_log", "event_type: invoice_cleared", "actor_role: Workflow Builder", "decision: cleared"),
	)
	return generatedCase(i, "PASS", "finance clearing valid long flow", "Invoice clearing follows receipt order with approval and audit.", "Workflow Builder", steps)
}

func generatePassCapabilityRequestLongFlow(i int) validatorAccuracyCase {
	prefix := fmt.Sprintf("gen_%04d", i)
	steps := append([]validatorGeneratedStep{}, readOnlyPrelude(prefix, i)...)
	steps = append(steps,
		generatedStep(prefix+"_capability_request", "capability.create_capability_request", "requested_capability: procurement.resolve_invoice_dispute", "business_reason: Needed for unsupported dispute workflow", "requester_role: Workflow Builder"),
		generatedStep(prefix+"_notify_finance", "notify_finance", fmt.Sprintf("message: Capability request %04d created for review", i)),
		generatedStep(prefix+"_audit", "audit.write_audit_log", "event_type: capability_request_created", "actor_role: Workflow Builder", "decision: requested"),
	)
	return generatedCase(i, "PASS", "capability request valid long flow", "Unsupported needs are routed through capability.create_capability_request with audit.", "Workflow Builder", steps)
}

func generatePassMixedNotificationLongFlow(i int) validatorAccuracyCase {
	prefix := fmt.Sprintf("gen_%04d", i)
	steps := append([]validatorGeneratedStep{}, readOnlyPrelude(prefix, i)...)
	steps = append(steps,
		generatedStep(prefix+"_policy_notify", "policy.check_policy_limit", "policy_domain: finance", fmt.Sprintf("amount: %d", 250000+i), "currency: LKR"),
		generatedStep(prefix+"_notify_finance", "notify_finance", fmt.Sprintf("message: Invoice exception workflow %04d needs review", i), "recipient_id: FIN-MGR"),
		generatedStep(prefix+"_send_webhook", "send_webhook", fmt.Sprintf("url: \"https://example.test/finance/%04d\"", i), fmt.Sprintf("payload: invoice_exception_%04d", i)),
		generatedStep(prefix+"_audit", "audit.write_audit_log", "event_type: finance_notification_sent", "actor_role: Workflow Builder", "decision: notified"),
	)
	return generatedCase(i, "PASS", "notification valid long flow", "Notification and webhook write actions include required params and audit.", "Workflow Builder", steps)
}

func generateBlockUnknownToolLongFlow(i int) validatorAccuracyCase {
	prefix := fmt.Sprintf("gen_%04d", i)
	steps := append([]validatorGeneratedStep{}, readOnlyPrelude(prefix, i)...)
	steps = append(steps,
		generatedStep(prefix+"_unknown", "procurement.auto_create_purchase_order", fmt.Sprintf("vendor_id: V-%04d", i), "item_id: LAPTOP", "quantity: 20"),
		generatedStep(prefix+"_audit", "audit.write_audit_log", "event_type: unknown_tool_attempted", "actor_role: Workflow Builder", "decision: blocked"),
	)
	return generatedCase(i, "BLOCK", "unknown tool blocked long flow", "Hallucinated tools must fail GLOBAL-SAFETY-001.", "Workflow Builder", steps)
}

func generateBlockMissingParameterLongFlow(i int) validatorAccuracyCase {
	prefix := fmt.Sprintf("gen_%04d", i)
	steps := append([]validatorGeneratedStep{}, readOnlyPrelude(prefix, i)...)
	steps = append(steps,
		generatedStep(prefix+"_validate_vendor", "procurement.validate_vendor", fmt.Sprintf("vendor_id: V-%04d", i)),
		generatedStep(prefix+"_approval", "approval.request_human_approval", "approval_reason: High-risk purchase order", "approver_role: procurement_manager"),
		generatedStep(prefix+"_create_po_missing_quantity", "procurement.create_purchase_order", fmt.Sprintf("vendor_id: V-%04d", i), fmt.Sprintf("item_id: ITEM-%04d", i)),
		generatedStep(prefix+"_audit", "audit.write_audit_log", "event_type: purchase_order_blocked", "actor_role: Workflow Builder", "decision: blocked"),
	)
	return generatedCase(i, "BLOCK", "missing parameter blocked long flow", "Purchase order without quantity must fail parameter checks.", "Workflow Builder", steps)
}

func generateBlockProcurementOrderLongFlow(i int) validatorAccuracyCase {
	prefix := fmt.Sprintf("gen_%04d", i)
	steps := append([]validatorGeneratedStep{}, readOnlyPrelude(prefix, i)...)
	steps = append(steps,
		generatedStep(prefix+"_approval", "approval.request_human_approval", "approval_reason: High-risk purchase order", "approver_role: procurement_manager"),
		generatedStep(prefix+"_create_po_before_vendor", "procurement.create_purchase_order", fmt.Sprintf("vendor_id: V-%04d", i), fmt.Sprintf("item_id: ITEM-%04d", i), "quantity: 25"),
		generatedStep(prefix+"_validate_vendor_late", "procurement.validate_vendor", fmt.Sprintf("vendor_id: V-%04d", i)),
		generatedStep(prefix+"_audit", "audit.write_audit_log", "event_type: purchase_order_blocked", "actor_role: Workflow Builder", "decision: blocked"),
	)
	return generatedCase(i, "BLOCK", "procurement order blocked long flow", "Vendor validation after purchase order must fail process order.", "Workflow Builder", steps)
}

func generateBlockMissingApprovalLongFlow(i int) validatorAccuracyCase {
	prefix := fmt.Sprintf("gen_%04d", i)
	steps := append([]validatorGeneratedStep{}, readOnlyPrelude(prefix, i)...)
	steps = append(steps,
		generatedStep(prefix+"_validate_vendor", "procurement.validate_vendor", fmt.Sprintf("vendor_id: V-%04d", i)),
		generatedStep(prefix+"_create_po_without_approval", "procurement.create_purchase_order", fmt.Sprintf("vendor_id: V-%04d", i), fmt.Sprintf("item_id: ITEM-%04d", i), "quantity: 150"),
		generatedStep(prefix+"_audit", "audit.write_audit_log", "event_type: purchase_order_blocked", "actor_role: Workflow Builder", "decision: blocked"),
	)
	return generatedCase(i, "BLOCK", "missing approval blocked long flow", "High-risk purchase order without approval must fail risk escalation.", "Workflow Builder", steps)
}

func generateBlockMissingAuditLongFlow(i int) validatorAccuracyCase {
	prefix := fmt.Sprintf("gen_%04d", i)
	steps := append([]validatorGeneratedStep{}, readOnlyPrelude(prefix, i)...)
	steps = append(steps,
		generatedStep(prefix+"_notify_finance", "notify_finance", fmt.Sprintf("message: Write workflow %04d has no audit", i)),
		generatedStep(prefix+"_send_webhook", "send_webhook", fmt.Sprintf("url: \"https://example.test/no-audit/%04d\"", i)),
	)
	return generatedCase(i, "BLOCK", "missing audit blocked long flow", "Write actions without audit.write_audit_log must fail audit policy.", "Workflow Builder", steps)
}

func generateBlockSecretLongFlow(i int) validatorAccuracyCase {
	prefix := fmt.Sprintf("gen_%04d", i)
	steps := append([]validatorGeneratedStep{}, readOnlyPrelude(prefix, i)...)
	steps = append(steps,
		generatedStep(prefix+"_secret_policy", "policy.check_policy_limit", "policy_domain: finance", "api_key: should_not_be_in_yaml", fmt.Sprintf("amount: %d", 50000+i)),
		generatedStep(prefix+"_classify_after_secret", "classify_invoice", fmt.Sprintf("invoiceId: INV-%04d", i)),
	)
	return generatedCase(i, "BLOCK", "secret parameter blocked long flow", "Credential-like parameters must fail data confidentiality checks.", "Workflow Builder", steps)
}

func generateBlockFinanceOrderLongFlow(i int) validatorAccuracyCase {
	prefix := fmt.Sprintf("gen_%04d", i)
	steps := append([]validatorGeneratedStep{}, readOnlyPrelude(prefix, i)...)
	steps = append(steps,
		generatedStep(prefix+"_approval", "approval.request_human_approval", "approval_reason: Critical invoice clearing", "approver_role: finance_manager"),
		generatedStep(prefix+"_clear_invoice_too_early", "finance.clear_invoice", fmt.Sprintf("invoice_id: INV-%04d", i)),
		generatedStep(prefix+"_invoice_receipt_late", "finance.record_invoice_receipt", fmt.Sprintf("invoice_id: INV-%04d", i)),
		generatedStep(prefix+"_goods_receipt_late", "inventory.record_goods_receipt", fmt.Sprintf("purchase_order_id: PO-%04d", i), "received_quantity: 12"),
		generatedStep(prefix+"_audit", "audit.write_audit_log", "event_type: invoice_clear_blocked", "actor_role: Workflow Builder", "decision: blocked"),
	)
	return generatedCase(i, "BLOCK", "finance order blocked long flow", "Invoice clear before receipts must fail finance process order.", "Workflow Builder", steps)
}

func generateBlockEmployeeInvoiceClearLongFlow(i int) validatorAccuracyCase {
	prefix := fmt.Sprintf("gen_%04d", i)
	steps := []validatorGeneratedStep{
		generatedStep(prefix+"_employee_policy", "policy_check", "intent: employee_invoice_clear_attempt"),
		generatedStep(prefix+"_employee_limit", "policy.check_policy_limit", "policy_domain: finance", fmt.Sprintf("amount: %d", 10000+i), "currency: LKR"),
		generatedStep(prefix+"_employee_policy_2", "policy_check", "intent: employee_secondary_precheck", fmt.Sprintf("quantity: %d", 1+i%10)),
		generatedStep(prefix+"_employee_limit_2", "policy.check_policy_limit", "policy_domain: finance", fmt.Sprintf("amount: %d", 11000+i), "currency: LKR"),
		generatedStep(prefix+"_employee_leave", "create_leave", fmt.Sprintf("employeeId: EMP-%04d", i), "start_date: 2026-06-10", "end_date: 2026-06-11", "leave_type: personal"),
		generatedStep(prefix+"_invoice_receipt", "finance.record_invoice_receipt", fmt.Sprintf("invoice_id: INV-%04d", i)),
		generatedStep(prefix+"_goods_receipt", "inventory.record_goods_receipt", fmt.Sprintf("purchase_order_id: PO-%04d", i), "received_quantity: 9"),
		generatedStep(prefix+"_clear_invoice", "finance.clear_invoice", fmt.Sprintf("invoice_id: INV-%04d", i)),
		generatedStep(prefix+"_audit", "audit.write_audit_log", "event_type: employee_invoice_clear_attempt", "actor_role: employee", "decision: blocked"),
	}
	return generatedCase(i, "BLOCK", "employee invoice clearing blocked long flow", "Employee role must not clear invoices.", "employee", steps)
}

func generateBlockInactiveVendorSemanticGapLongFlow(i int) validatorAccuracyCase {
	prefix := fmt.Sprintf("gen_%04d", i)
	quantity := 25 + i%40
	steps := append([]validatorGeneratedStep{}, readOnlyPrelude(prefix, i)...)
	steps = append(steps,
		generatedStep(prefix+"_validate_vendor", "procurement.validate_vendor", fmt.Sprintf("vendor_id: V-%04d", i), "vendor_active: false"),
		generatedStep(prefix+"_proc_policy", "policy.check_policy_limit", "policy_domain: procurement", fmt.Sprintf("quantity: %d", quantity), "currency: LKR"),
		generatedStep(prefix+"_approval", "approval.request_human_approval", "approval_reason: Vendor master data shows inactive supplier", "approver_role: procurement_manager", fmt.Sprintf("quantity: %d", quantity)),
		generatedStep(prefix+"_create_po", "procurement.create_purchase_order", fmt.Sprintf("vendor_id: V-%04d", i), fmt.Sprintf("item_id: ITEM-%04d", i), fmt.Sprintf("quantity: %d", quantity), "currency: LKR"),
		generatedStep(prefix+"_audit", "audit.write_audit_log", "event_type: inactive_vendor_purchase_blocked", "actor_role: Workflow Builder", "decision: blocked"),
	)
	return generatedCase(i, "BLOCK", "inactive vendor semantic gap long flow", "Business ground truth blocks inactive vendors, but the registry-only validator cannot inspect live vendor state.", "Workflow Builder", steps)
}

func generatedCase(i int, expectedResult, title, focus, userRole string, steps []validatorGeneratedStep) validatorAccuracyCase {
	caseID := fmt.Sprintf("GEN-%04d", i)
	return validatorAccuracyCase{
		CaseID:         caseID,
		Title:          title,
		UserRole:       userRole,
		ExpectedResult: expectedResult,
		Focus:          focus,
		YAMLLines:      generatedWorkflowLines(caseID, title, steps),
	}
}

func readOnlyPrelude(prefix string, i int) []validatorGeneratedStep {
	return []validatorGeneratedStep{
		generatedStep(prefix+"_policy_1", "policy_check", "intent: validator_accuracy_precheck", fmt.Sprintf("amount: %d", 10000+i)),
		generatedStep(prefix+"_classify_1", "classify_invoice", fmt.Sprintf("invoiceId: INV-%04d", i)),
		generatedStep(prefix+"_policy_limit_1", "policy.check_policy_limit", "policy_domain: finance", fmt.Sprintf("amount: %d", 25000+i), "currency: LKR"),
		generatedStep(prefix+"_attendance_1", "fetch_attendance", fmt.Sprintf("employeeId: EMP-%04d", i), "date_from: 2026-05-01", "date_to: 2026-05-31"),
		generatedStep(prefix+"_policy_2", "policy_check", "intent: validator_accuracy_secondary_precheck", fmt.Sprintf("quantity: %d", 1+i%50)),
		generatedStep(prefix+"_classify_2", "classify_invoice", fmt.Sprintf("invoiceId: INV-%04d-R", i)),
	}
}

func generatedStep(id, action string, params ...string) validatorGeneratedStep {
	return validatorGeneratedStep{ID: id, Action: action, Params: params}
}

func generatedWorkflowLines(caseID, title string, steps []validatorGeneratedStep) []string {
	lines := []string{
		"name: " + strings.ToLower(strings.ReplaceAll(caseID, "-", "_")),
		"description: " + title,
		"trigger:",
		"  type: user.requested",
		"steps:",
	}
	for _, step := range steps {
		lines = append(lines,
			"  - id: "+step.ID,
			"    action: "+step.Action,
		)
		if len(step.Params) == 0 {
			lines = append(lines, "    parameters: {}")
			continue
		}
		lines = append(lines, "    parameters:")
		for _, param := range step.Params {
			lines = append(lines, "      "+param)
		}
	}
	return lines
}

func writeValidatorFlowDataset(t *testing.T, path string, cases []validatorAccuracyCase) {
	t.Helper()
	type flowRecord struct {
		CaseID         string `json:"case_id"`
		Title          string `json:"title"`
		Focus          string `json:"focus"`
		UserRole       string `json:"user_role"`
		ExpectedResult string `json:"expected_result"`
		YAML           string `json:"yaml"`
	}

	var b strings.Builder
	for _, tc := range cases {
		raw, err := json.Marshal(flowRecord{
			CaseID:         tc.CaseID,
			Title:          tc.Title,
			Focus:          tc.Focus,
			UserRole:       tc.UserRole,
			ExpectedResult: strings.ToUpper(tc.ExpectedResult),
			YAML:           strings.Join(tc.YAMLLines, "\n") + "\n",
		})
		if err != nil {
			t.Fatalf("encode generated flow %s: %v", tc.CaseID, err)
		}
		b.Write(raw)
		b.WriteByte('\n')
	}
	writeReportFile(t, path, b.String())
}

func countWorkflowActionLines(lines []string) int {
	count := 0
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "action: ") {
			count++
		}
	}
	return count
}

func validatorMetricTextChart(metrics validatorAccuracyMetrics) string {
	values := []struct {
		label string
		value float64
	}{
		{"accuracy ", metrics.Accuracy},
		{"precision", metrics.Precision},
		{"recall   ", metrics.Recall},
		{"f1       ", metrics.F1},
		{"mcc      ", metrics.MCC},
	}
	var b strings.Builder
	for _, item := range values {
		width := int(math.Round(clamp01(item.value) * 24))
		fmt.Fprintf(&b, "%s | %-24s %.3f\n", item.label, strings.Repeat("#", width), item.value)
	}
	return b.String()
}

func repoRootFromTest(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve test file path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

func safeRatio(numerator, denominator float64) float64 {
	if denominator == 0 {
		return 0
	}
	return numerator / denominator
}

func clamp01(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

func maxInt(values ...int) int {
	max := 0
	for _, value := range values {
		if value > max {
			max = value
		}
	}
	if max == 0 {
		return 1
	}
	return max
}

var _ = workflowvalidator.CandidateValidationResult{}
