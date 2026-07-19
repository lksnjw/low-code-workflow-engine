package eval

import (
	"bufio"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"

	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"go.uber.org/zap"
)

const (
	Seed           int64 = 20260720
	SafeFilename         = "safe_workflows.jsonl"
	UnsafeFilename       = "unsafe_workflows.jsonl"
)

type Case struct {
	ID            string                 `json:"id"`
	Label         string                 `json:"label"`
	ViolationType string                 `json:"violation_type"`
	YAML          string                 `json:"yaml"`
	Expected      string                 `json:"expected"`
	ExpectedRule  string                 `json:"expected_rule"`
	UserRole      string                 `json:"user_role"`
	Input         map[string]interface{} `json:"input,omitempty"`
}

type Summary struct {
	Seed             int64             `json:"seed"`
	Safe             int               `json:"safe"`
	Unsafe           int               `json:"unsafe"`
	SafeByType       map[string]int    `json:"safe_by_type"`
	UnsafeByType     map[string]int    `json:"unsafe_by_type"`
	RegistryVersions map[string]string `json:"registry_versions"`
	CoverageGaps     []string          `json:"coverage_gaps,omitempty"`
}

// Generate loads the production-format registries, constructs deterministic
// cases, verifies their gate evidence, and writes the two JSONL artifacts.
func Generate(toolRegistryPath, ruleRegistryPath, outputDir string) (Summary, error) {
	bundle, err := coreregistry.LoadBundle(toolRegistryPath, ruleRegistryPath, zap.NewNop())
	if err != nil {
		return Summary{}, fmt.Errorf("load real registries: %w", err)
	}
	if err := requireRegistryEntries(bundle); err != nil {
		return Summary{}, err
	}

	rng := rand.New(rand.NewSource(Seed))
	sodRuleID := separationOfDutiesRuleID(bundle.Rules.GetEnabledRules())
	coverageGaps := []string{}
	if sodRuleID == "" {
		sodRuleID = "UNCONFIGURED-SEPARATION-OF-DUTIES"
		coverageGaps = append(coverageGaps, "the real rule registry has no enabled separation_of_duties rule; the six self-approval cases are policy ground-truth false-negative probes")
	}

	safe, unsafe := buildCases(rng, sodRuleID)
	gate := workflowvalidator.NewRegistryValidator(bundle.Tools, bundle.Rules, repository.NewStore())
	if err := verifyGeneratedCases(gate, safe, unsafe, sodRuleID == "UNCONFIGURED-SEPARATION-OF-DUTIES"); err != nil {
		return Summary{}, err
	}
	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		return Summary{}, fmt.Errorf("create output directory: %w", err)
	}
	if err := writeJSONL(filepath.Join(outputDir, SafeFilename), safe); err != nil {
		return Summary{}, err
	}
	if err := writeJSONL(filepath.Join(outputDir, UnsafeFilename), unsafe); err != nil {
		return Summary{}, err
	}

	return Summary{
		Seed:             Seed,
		Safe:             len(safe),
		Unsafe:           len(unsafe),
		SafeByType:       countByType(safe),
		UnsafeByType:     countByType(unsafe),
		RegistryVersions: map[string]string{"tools": bundle.Versions.Tools, "rules": bundle.Versions.Rules},
		CoverageGaps:     coverageGaps,
	}, nil
}

func requireRegistryEntries(bundle *coreregistry.Bundle) error {
	for _, name := range []string{
		"classify_invoice",
		"approval.request_human_approval",
		"audit.write_audit_log",
		"procurement.validate_vendor",
		"procurement.create_purchase_order",
		"finance.record_invoice_receipt",
		"inventory.record_goods_receipt",
		"finance.clear_invoice",
	} {
		if _, ok := bundle.Tools.FindToolByName(name); !ok {
			return fmt.Errorf("real tool registry is missing required dataset tool %q", name)
		}
	}
	for _, id := range []string{"GLOBAL-SAFETY-001", "GLOBAL-SAFETY-002", "GLOBAL-SAFETY-003", "PROC-THRESH-001", "FIN-RBAC-001"} {
		if !hasRule(bundle.Rules.GetEnabledRules(), id) {
			return fmt.Errorf("real rule registry is missing required dataset rule %q", id)
		}
	}
	return nil
}

func buildCases(rng *rand.Rand, sodRuleID string) ([]Case, []Case) {
	safe := make([]Case, 0, 60)
	unsafe := make([]Case, 0, 60)
	for i := 1; i <= 10; i++ {
		safe = append(safe, newCase("safe_unknown_tool", i, "safe", "unknown_tool", "allow", "GLOBAL-SAFETY-001", "Workflow Builder", readWorkflow(fmt.Sprintf("safe_unknown_%02d", i), "classify_invoice", "      document_id: INV-SAFE-"+fmt.Sprintf("%02d", i)), nil))
		unsafe = append(unsafe, newCase("unsafe_unknown_tool", i, "unsafe", "unknown_tool", "block", "GLOBAL-SAFETY-001", "Workflow Builder", readWorkflow(fmt.Sprintf("unsafe_unknown_%02d", i), fmt.Sprintf("eval.unknown_tool_%02d", i), "      reference: UNKNOWN-"+fmt.Sprintf("%02d", i)), nil))
	}
	for i := 1; i <= 10; i++ {
		safeQuantity := 100 - rng.Intn(2)
		unsafeQuantity := 101 + rng.Intn(50)
		safe = append(safe, newCase("safe_threshold_literal", i, "safe", "over_threshold_literal", "allow", "PROC-THRESH-001", "Workflow Builder", purchaseWorkflow(fmt.Sprintf("safe_literal_%02d", i), fmt.Sprint(safeQuantity), true), nil))
		unsafe = append(unsafe, newCase("unsafe_threshold_literal", i, "unsafe", "over_threshold_literal", "block", "PROC-THRESH-001", "Workflow Builder", purchaseWorkflow(fmt.Sprintf("unsafe_literal_%02d", i), fmt.Sprint(unsafeQuantity), false), nil))
	}
	for i := 1; i <= 10; i++ {
		safeAmount := 99 + rng.Intn(2)
		unsafeAmount := 101 + rng.Intn(500)
		safe = append(safe, newCase("safe_threshold_variable", i, "safe", "over_threshold_variable", "allow", "PROC-THRESH-001", "Workflow Builder", purchaseWorkflow(fmt.Sprintf("safe_variable_%02d", i), `"{{input.amount}}"`, true), map[string]interface{}{"amount": safeAmount}))
		unsafe = append(unsafe, newCase("unsafe_threshold_variable", i, "unsafe", "over_threshold_variable", "block", "PROC-THRESH-001", "Workflow Builder", purchaseWorkflow(fmt.Sprintf("unsafe_variable_%02d", i), `"{{input.amount}}"`, false), map[string]interface{}{"amount": unsafeAmount}))
	}
	for i := 1; i <= 10; i++ {
		safe = append(safe, newCase("safe_rbac", i, "safe", "rbac_violation", "allow", "FIN-RBAC-001", "Platform Admin", financeWorkflow(fmt.Sprintf("safe_rbac_%02d", i)), nil))
		unsafe = append(unsafe, newCase("unsafe_rbac", i, "unsafe", "rbac_violation", "block", "FIN-RBAC-001", "employee", financeWorkflow(fmt.Sprintf("unsafe_rbac_%02d", i)), nil))
	}
	for i := 1; i <= 8; i++ {
		safe = append(safe, newCase("safe_risk_approval", i, "safe", "missing_approval", "allow", "GLOBAL-SAFETY-003", "Workflow Builder", purchaseWorkflow(fmt.Sprintf("safe_approval_%02d", i), "50", true), nil))
		unsafe = append(unsafe, newCase("unsafe_risk_approval", i, "unsafe", "missing_approval", "block", "GLOBAL-SAFETY-003", "Workflow Builder", purchaseWorkflow(fmt.Sprintf("unsafe_approval_%02d", i), "50", false), nil))
	}
	for i := 1; i <= 6; i++ {
		safe = append(safe, newCase("safe_separation_of_duties", i, "safe", "self_approval", "allow", sodRuleID, "Workflow Builder", approvalWorkflow(fmt.Sprintf("safe_sod_%02d", i), fmt.Sprintf("requester-%02d", i), fmt.Sprintf("approver-%02d", i)), nil))
		unsafe = append(unsafe, newCase("unsafe_separation_of_duties", i, "unsafe", "self_approval", "block", sodRuleID, "Workflow Builder", approvalWorkflow(fmt.Sprintf("unsafe_sod_%02d", i), fmt.Sprintf("actor-%02d", i), fmt.Sprintf("actor-%02d", i)), nil))
	}
	for i := 1; i <= 6; i++ {
		safe = append(safe, newCase("safe_credential", i, "safe", "credential_in_param", "allow", "GLOBAL-SAFETY-002", "Workflow Builder", readWorkflow(fmt.Sprintf("safe_credential_%02d", i), "classify_invoice", "      credential_reference: vault-ref-"+fmt.Sprintf("%02d", i)), nil))
		unsafe = append(unsafe, newCase("unsafe_credential", i, "unsafe", "credential_in_param", "block", "GLOBAL-SAFETY-002", "Workflow Builder", readWorkflow(fmt.Sprintf("unsafe_credential_%02d", i), "classify_invoice", "      api_key: eval-secret-placeholder-"+fmt.Sprintf("%02d", i)), nil))
	}
	return safe, unsafe
}

func newCase(prefix string, index int, label, violationType, expected, expectedRule, role, rawYAML string, input map[string]interface{}) Case {
	return Case{
		ID: fmt.Sprintf("%s_%02d", prefix, index), Label: label, ViolationType: violationType,
		YAML: rawYAML, Expected: expected, ExpectedRule: expectedRule, UserRole: role, Input: input,
	}
}

func readWorkflow(name, action, parameterLine string) string {
	return fmt.Sprintf(`name: %s
description: Deterministic evaluation workflow for a registry tool-validity boundary.
trigger:
  type: manual
steps:
  - id: evaluate
    action: %s
    parameters:
%s
`, name, action, parameterLine)
}

func purchaseWorkflow(name, quantity string, includeApproval bool) string {
	approval := ""
	if includeApproval {
		approval = `  - id: approval
    action: approval.request_human_approval
    parameters:
      approval_reason: Purchase quantity or risk review
      approver_role: procurement_manager
`
	}
	return fmt.Sprintf(`name: %s
description: Deterministic procurement threshold and approval evaluation workflow.
trigger:
  type: manual
steps:
  - id: validate_vendor
    action: procurement.validate_vendor
    parameters:
      vendor_id: V-EVAL
%s  - id: create_order
    action: procurement.create_purchase_order
    parameters:
      vendor_id: V-EVAL
      item_id: ITEM-EVAL
      quantity: %s
  - id: audit
    action: audit.write_audit_log
    parameters:
      event_type: purchase_order_evaluation
      actor_role: Workflow Builder
      decision: evaluated
`, name, approval, quantity)
}

func financeWorkflow(name string) string {
	return fmt.Sprintf(`name: %s
description: Deterministic finance RBAC and process-order evaluation workflow.
trigger:
  type: manual
steps:
  - id: invoice_receipt
    action: finance.record_invoice_receipt
    parameters:
      invoice_id: INV-EVAL
  - id: goods_receipt
    action: inventory.record_goods_receipt
    parameters:
      purchase_order_id: PO-EVAL
      received_quantity: 1
  - id: approval
    action: approval.request_human_approval
    parameters:
      approval_reason: Critical invoice clearing review
      approver_role: finance_manager
  - id: clear_invoice
    action: finance.clear_invoice
    parameters:
      invoice_id: INV-EVAL
  - id: audit
    action: audit.write_audit_log
    parameters:
      event_type: invoice_clear_evaluation
      actor_role: Platform Admin
      decision: evaluated
`, name)
}

func approvalWorkflow(name, requesterID, approverID string) string {
	return fmt.Sprintf(`name: %s
description: Deterministic self-approval and separation-of-duties evaluation workflow.
trigger:
  type: manual
steps:
  - id: approval
    action: approval.request_human_approval
    parameters:
      approval_reason: Separation-of-duties evaluation
      approver_role: department_manager
      requester_id: %s
      approver_id: %s
  - id: audit
    action: audit.write_audit_log
    parameters:
      event_type: approval_evaluation
      actor_role: Workflow Builder
      decision: evaluated
`, name, requesterID, approverID)
}

func verifyGeneratedCases(gate *workflowvalidator.RegistryValidator, safe, unsafe []Case, sodRuleMissing bool) error {
	for _, item := range safe {
		token, result, err := gate.ValidateAndIssueToken("dataset."+item.ID, item.YAML, item.UserRole)
		if err != nil || !result.Passed || token == nil {
			return fmt.Errorf("safe case %s did not pass the real gate: result=%+v err=%v", item.ID, result, err)
		}
		if item.ViolationType == "over_threshold_variable" {
			blueprint, err := workflowvalidator.ParseWorkflowYAMLStrict(item.YAML)
			if err != nil {
				return fmt.Errorf("parse safe variable case %s: %w", item.ID, err)
			}
			if violation := gate.EvaluateResolvedStep("dataset.dispatch."+item.ID, blueprint, 2, map[string]interface{}{"quantity": item.Input["amount"]}, token); violation != nil {
				return fmt.Errorf("safe variable case %s failed dispatch rule %s", item.ID, violation.RuleID)
			}
		}
	}
	for _, item := range unsafe {
		token, result, err := gate.ValidateAndIssueToken("dataset."+item.ID, item.YAML, item.UserRole)
		if err != nil {
			return fmt.Errorf("validate unsafe case %s: %w", item.ID, err)
		}
		switch item.ViolationType {
		case "over_threshold_variable":
			if !deferredRuleFound(result.DeferredChecks, item.ExpectedRule) {
				return fmt.Errorf("unsafe variable case %s did not defer %s", item.ID, item.ExpectedRule)
			}
			blueprint, parseErr := workflowvalidator.ParseWorkflowYAMLStrict(item.YAML)
			if parseErr != nil {
				return fmt.Errorf("parse unsafe variable case %s: %w", item.ID, parseErr)
			}
			probe := &models.ValidationToken{WorkflowContentHash: workflowvalidator.WorkflowContentHash(item.YAML), RegistryHash: gate.RegistryHash(), DeferredChecks: result.DeferredChecks}
			violation := gate.EvaluateResolvedStep("dataset.dispatch."+item.ID, blueprint, 1, map[string]interface{}{"quantity": item.Input["amount"]}, probe)
			if violation == nil || violation.RuleID != item.ExpectedRule {
				return fmt.Errorf("unsafe variable case %s did not produce dispatch rule %s: %+v", item.ID, item.ExpectedRule, violation)
			}
		case "self_approval":
			if sodRuleMissing {
				if !result.Passed || token == nil {
					return fmt.Errorf("self-approval coverage probe %s unexpectedly failed another rule: %+v", item.ID, result)
				}
			} else if result.Passed || !contains(result.FailedRules, item.ExpectedRule) {
				return fmt.Errorf("unsafe self-approval case %s did not fail %s: %+v", item.ID, item.ExpectedRule, result)
			}
		default:
			if result.Passed || token != nil || !contains(result.FailedRules, item.ExpectedRule) {
				return fmt.Errorf("unsafe case %s did not fail expected rule %s: %+v", item.ID, item.ExpectedRule, result)
			}
		}
	}
	return nil
}

func writeJSONL(path string, cases []Case) error {
	file, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	writer := bufio.NewWriter(file)
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	for _, item := range cases {
		if err := encoder.Encode(item); err != nil {
			_ = file.Close()
			return fmt.Errorf("encode %s: %w", item.ID, err)
		}
	}
	if err := writer.Flush(); err != nil {
		_ = file.Close()
		return fmt.Errorf("flush %s: %w", path, err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close %s: %w", path, err)
	}
	return nil
}

func separationOfDutiesRuleID(rules []coreregistry.Rule) string {
	for _, rule := range rules {
		if rule.RuleType == "separation_of_duties" {
			return rule.RuleID
		}
	}
	return ""
}

func hasRule(rules []coreregistry.Rule, id string) bool {
	for _, rule := range rules {
		if rule.RuleID == id {
			return true
		}
	}
	return false
}

func deferredRuleFound(checks []models.DeferredCheck, ruleID string) bool {
	for _, check := range checks {
		if contains(check.RuleIDs, ruleID) {
			return true
		}
	}
	return false
}

func contains(items []string, wanted string) bool {
	for _, item := range items {
		if item == wanted {
			return true
		}
	}
	return false
}

func countByType(cases []Case) map[string]int {
	counts := map[string]int{}
	for _, item := range cases {
		counts[item.ViolationType]++
	}
	return counts
}

func SortedBreakdown(counts map[string]int) []string {
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	items := make([]string, 0, len(keys))
	for _, key := range keys {
		items = append(items, fmt.Sprintf("%s=%d", key, counts[key]))
	}
	return items
}

func FormatSummary(summary Summary) string {
	parts := []string{
		fmt.Sprintf("seed=%d", summary.Seed),
		fmt.Sprintf("safe=%d", summary.Safe),
		fmt.Sprintf("unsafe=%d", summary.Unsafe),
		"unsafe_by_type=" + strings.Join(SortedBreakdown(summary.UnsafeByType), ","),
	}
	if len(summary.CoverageGaps) > 0 {
		parts = append(parts, "coverage_gaps="+strings.Join(summary.CoverageGaps, "; "))
	}
	return strings.Join(parts, "\n")
}
