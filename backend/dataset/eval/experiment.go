//go:build experiment

package eval

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/runner"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
	"go.uber.org/zap"
)

const (
	ModeGateOn                   = "gate_on"
	ModeGateOff                  = "gate_off"
	PredictionBlock              = "BLOCK"
	PredictionAllow              = "ALLOW"
	ExperimentCSVFilename        = "experiment_results.csv"
	ExperimentMetricsFile        = "metrics.json"
	SelfApprovalCaveat           = "The 6 unsafe self_approval cases have no enabled separation_of_duties evaluator; a gate-on block caused by another fail-closed rule does not demonstrate separation-of-duties enforcement."
	EvaluationRegistryHashBefore = "sha256:c1bc1f5ddd4f342e26ff0dae5133358bb660205f8cdd15ecc636b3cf26dcef39"
	ProductionEvaluatorCaveat    = "The disabled evaluation families have no complete registry-condition evaluator and fail closed in production."
	defaultExperimentAction      = "experiment"
)

var experimentCSVHeader = []string{
	"id",
	"label",
	"violation_type",
	"mode",
	"predicted",
	"expected",
	"correct",
	"rule_fired",
	"blocked_stage",
	"latency_ms",
	"disabled_rule_ids",
	"disabled_rule_families",
	"rule_registry_hash",
	"production_fail_closed_caveat",
}

type ExperimentConfig struct {
	Cases            []Case
	ToolRegistryPath string
	RuleRegistryPath string
	OutputDir        string
	Environment      string
}

type ExperimentRow struct {
	ID            string
	Label         string
	ViolationType string
	Mode          string
	Predicted     string
	Expected      string
	Correct       bool
	RuleFired     string
	BlockedStage  string
	LatencyMS     float64
}

type ModeMetrics struct {
	TP                     int                `json:"tp"`
	FP                     int                `json:"fp"`
	TN                     int                `json:"tn"`
	FN                     int                `json:"fn"`
	Recall                 float64            `json:"recall"`
	Precision              float64            `json:"precision"`
	FalseNegativeRate      float64            `json:"false_negative_rate"`
	F1                     float64            `json:"f1"`
	PerViolationTypeRecall map[string]float64 `json:"per_violation_type_recall"`
	MeanLatencyMS          float64            `json:"mean_latency_ms"`
}

type DisabledEvaluationRule struct {
	RuleID string `json:"rule_id"`
	Family string `json:"family"`
}

type MetricsReport struct {
	Cases                      int                      `json:"cases"`
	Rows                       int                      `json:"rows"`
	PositiveClass              string                   `json:"positive_class"`
	ZeroDenominatorConvention  string                   `json:"zero_denominator_convention"`
	KnownCaveat                string                   `json:"known_caveat"`
	DisabledRules              []DisabledEvaluationRule `json:"disabled_rules"`
	DisabledRuleFamilies       []string                 `json:"disabled_rule_families"`
	RegistryHashBefore         string                   `json:"registry_hash_before"`
	RegistryHashAfter          string                   `json:"registry_hash_after"`
	ProductionFailClosedCaveat string                   `json:"production_fail_closed_caveat"`
	Modes                      map[string]ModeMetrics   `json:"modes"`
}

type ExperimentReport struct {
	Rows    []ExperimentRow
	Metrics MetricsReport
}

func LoadExperimentCases(paths ...string) ([]Case, error) {
	all := make([]Case, 0)
	seen := map[string]struct{}{}
	for _, path := range paths {
		file, err := os.Open(path)
		if err != nil {
			return nil, fmt.Errorf("open experiment cases %s: %w", path, err)
		}
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for line := 1; scanner.Scan(); line++ {
			var item Case
			if err := json.Unmarshal(scanner.Bytes(), &item); err != nil {
				_ = file.Close()
				return nil, fmt.Errorf("parse experiment cases %s line %d: %w", path, line, err)
			}
			if err := validateExperimentCase(item); err != nil {
				_ = file.Close()
				return nil, fmt.Errorf("invalid experiment case %s line %d: %w", path, line, err)
			}
			if _, exists := seen[item.ID]; exists {
				_ = file.Close()
				return nil, fmt.Errorf("duplicate experiment case id %q", item.ID)
			}
			seen[item.ID] = struct{}{}
			all = append(all, item)
		}
		if err := scanner.Err(); err != nil {
			_ = file.Close()
			return nil, fmt.Errorf("scan experiment cases %s: %w", path, err)
		}
		if err := file.Close(); err != nil {
			return nil, fmt.Errorf("close experiment cases %s: %w", path, err)
		}
	}
	if len(all) == 0 {
		return nil, errors.New("experiment dataset is empty")
	}
	return all, nil
}

func RunExperiment(ctx context.Context, cfg ExperimentConfig) (ExperimentReport, error) {
	if len(cfg.Cases) == 0 {
		return ExperimentReport{}, errors.New("experiment requires at least one case")
	}
	if strings.TrimSpace(cfg.OutputDir) == "" {
		return ExperimentReport{}, errors.New("experiment output directory is required")
	}
	if !strings.EqualFold(strings.TrimSpace(cfg.Environment), "experiment") {
		return ExperimentReport{}, fmt.Errorf("experiment baseline requires APP_ENV=experiment, got %q", cfg.Environment)
	}
	bundle, err := coreregistry.LoadBundle(cfg.ToolRegistryPath, cfg.RuleRegistryPath, zap.NewNop())
	if err != nil {
		return ExperimentReport{}, fmt.Errorf("load experiment registries: %w", err)
	}
	registryHash, err := fileSHA256(cfg.RuleRegistryPath)
	if err != nil {
		return ExperimentReport{}, fmt.Errorf("hash experiment rule registry: %w", err)
	}
	disabledRules, disabledFamilies := disabledNoEvaluatorRules(bundle)

	rows := make([]ExperimentRow, 0, len(cfg.Cases)*2)
	for _, item := range cfg.Cases {
		for _, mode := range []string{ModeGateOn, ModeGateOff} {
			row, runErr := runExperimentCase(ctx, bundle, item, mode)
			if runErr != nil {
				return ExperimentReport{}, fmt.Errorf("run case %s in %s: %w", item.ID, mode, runErr)
			}
			rows = append(rows, row)
		}
	}

	metrics := calculateMetrics(len(cfg.Cases), rows)
	metrics.DisabledRules = disabledRules
	metrics.DisabledRuleFamilies = disabledFamilies
	metrics.RegistryHashBefore = EvaluationRegistryHashBefore
	metrics.RegistryHashAfter = registryHash
	metrics.ProductionFailClosedCaveat = ProductionEvaluatorCaveat
	if err := os.MkdirAll(cfg.OutputDir, 0o755); err != nil {
		return ExperimentReport{}, fmt.Errorf("create experiment output directory: %w", err)
	}
	if err := writeExperimentCSV(filepath.Join(cfg.OutputDir, ExperimentCSVFilename), rows, metrics); err != nil {
		return ExperimentReport{}, err
	}
	if err := writeExperimentMetrics(filepath.Join(cfg.OutputDir, ExperimentMetricsFile), metrics); err != nil {
		return ExperimentReport{}, err
	}
	return ExperimentReport{Rows: rows, Metrics: metrics}, nil
}

func validateExperimentCase(item Case) error {
	if strings.TrimSpace(item.ID) == "" || strings.TrimSpace(item.YAML) == "" || strings.TrimSpace(item.UserRole) == "" {
		return errors.New("id, yaml, and user_role are required")
	}
	label := strings.ToLower(strings.TrimSpace(item.Label))
	expected := strings.ToLower(strings.TrimSpace(item.Expected))
	if label != "safe" && label != "unsafe" {
		return fmt.Errorf("unsupported label %q", item.Label)
	}
	if expected != "allow" && expected != "block" {
		return fmt.Errorf("unsupported expected decision %q", item.Expected)
	}
	if (label == "safe" && expected != "allow") || (label == "unsafe" && expected != "block") {
		return fmt.Errorf("label %q conflicts with expected decision %q", item.Label, item.Expected)
	}
	return nil
}

func runExperimentCase(ctx context.Context, bundle *coreregistry.Bundle, item Case, mode string) (ExperimentRow, error) {
	started := time.Now()
	store := repository.NewStore()
	gate := workflowvalidator.NewRegistryValidator(bundle.Tools, bundle.Rules, store)
	spy := &experimentSpyTool{}
	executableTools := tools.NewRegistry(spy)
	executor := runner.NewExecutor(executableTools, gate, zap.NewNop())
	gateOff := mode == ModeGateOff
	if err := executor.SetBaselineB(gateOff); err != nil {
		return ExperimentRow{}, fmt.Errorf("configure experiment executor: %w", err)
	}

	token, validation, err := gate.ValidateAndIssueToken(defaultExperimentAction+".plan."+item.ID+"."+mode, item.YAML, item.UserRole)
	if err != nil {
		return ExperimentRow{}, fmt.Errorf("plan validation: %w", err)
	}
	rules := append([]string{}, validation.FailedRules...)
	blockedStage := "none"
	predicted := PredictionAllow

	if !validation.Passed && !gateOff {
		predicted = PredictionBlock
		blockedStage = "plan"
	} else {
		if !validation.Passed {
			gate.AuditBaselineBypass(
				defaultExperimentAction+".plan."+item.ID,
				item.UserRole,
				workflowvalidator.WorkflowContentHash(item.YAML),
				"plan_validation",
				"full registry validation would have blocked execution",
				map[string]interface{}{"failed_rules": append([]string{}, validation.FailedRules...), "errors": append([]string{}, validation.Errors...)},
			)
		}
		blueprint, parseErr := workflowvalidator.ParseWorkflowYAMLStrict(item.YAML)
		if parseErr != nil {
			return ExperimentRow{}, fmt.Errorf("parse workflow for runner: %w", parseErr)
		}
		workflow := models.Workflow{ID: item.ID, Name: item.ID, YAML: item.YAML}
		_, runErr := executor.Run(ctx, "experiment-"+mode+"-"+item.ID, workflow, item.Input, token)
		if runErr != nil {
			var policyErr *runner.ErrDispatchPolicyViolation
			if !errors.As(runErr, &policyErr) {
				return ExperimentRow{}, fmt.Errorf("runner: %w", runErr)
			}
			if gateOff {
				return ExperimentRow{}, fmt.Errorf("Baseline B unexpectedly enforced dispatch rule %s", policyErr.RuleID)
			}
			predicted = PredictionBlock
			blockedStage = "dispatch"
			rules = append(rules, policyErr.RuleID)
			if policyErr.StepIndex >= 0 && policyErr.StepIndex < len(blueprint.Steps) && spy.Executed(blueprint.Steps[policyErr.StepIndex].Action) {
				return ExperimentRow{}, fmt.Errorf("dispatch-blocked tool %s executed", blueprint.Steps[policyErr.StepIndex].Action)
			}
		}
		if runErr == nil && spy.CallCount() != len(blueprint.Steps) {
			return ExperimentRow{}, fmt.Errorf("runner invoked %d spy tools, want %d workflow steps", spy.CallCount(), len(blueprint.Steps))
		}
	}

	expected := strings.ToUpper(strings.TrimSpace(item.Expected))
	ruleFired := "none"
	if predicted == PredictionBlock {
		ruleFired = strings.Join(uniqueSortedStrings(rules), ";")
		if ruleFired == "" {
			return ExperimentRow{}, errors.New("blocked decision has no rule evidence")
		}
	}
	return ExperimentRow{
		ID:            item.ID,
		Label:         strings.ToLower(strings.TrimSpace(item.Label)),
		ViolationType: item.ViolationType,
		Mode:          mode,
		Predicted:     predicted,
		Expected:      expected,
		Correct:       predicted == expected,
		RuleFired:     ruleFired,
		BlockedStage:  blockedStage,
		LatencyMS:     float64(time.Since(started).Nanoseconds()) / float64(time.Millisecond),
	}, nil
}

func calculateMetrics(caseCount int, rows []ExperimentRow) MetricsReport {
	report := MetricsReport{
		Cases:                     caseCount,
		Rows:                      len(rows),
		PositiveClass:             "unsafe",
		ZeroDenominatorConvention: "metrics with a zero denominator are reported as 0",
		KnownCaveat:               SelfApprovalCaveat,
		Modes:                     map[string]ModeMetrics{},
	}
	for _, mode := range []string{ModeGateOn, ModeGateOff} {
		metrics := ModeMetrics{PerViolationTypeRecall: map[string]float64{}}
		unsafeByType := map[string]int{}
		blockedUnsafeByType := map[string]int{}
		latencyTotal := 0.0
		modeRows := 0
		for _, row := range rows {
			if row.Mode != mode {
				continue
			}
			modeRows++
			latencyTotal += row.LatencyMS
			unsafe := row.Label == "unsafe"
			blocked := row.Predicted == PredictionBlock
			switch {
			case unsafe && blocked:
				metrics.TP++
			case !unsafe && blocked:
				metrics.FP++
			case !unsafe && !blocked:
				metrics.TN++
			case unsafe && !blocked:
				metrics.FN++
			}
			if unsafe {
				unsafeByType[row.ViolationType]++
				if blocked {
					blockedUnsafeByType[row.ViolationType]++
				}
			}
		}
		metrics.Recall = ratio(metrics.TP, metrics.TP+metrics.FN)
		metrics.Precision = ratio(metrics.TP, metrics.TP+metrics.FP)
		metrics.FalseNegativeRate = ratio(metrics.FN, metrics.TP+metrics.FN)
		if metrics.Precision+metrics.Recall > 0 {
			metrics.F1 = 2 * metrics.Precision * metrics.Recall / (metrics.Precision + metrics.Recall)
		}
		if modeRows > 0 {
			metrics.MeanLatencyMS = latencyTotal / float64(modeRows)
		}
		for violationType, total := range unsafeByType {
			metrics.PerViolationTypeRecall[violationType] = ratio(blockedUnsafeByType[violationType], total)
		}
		report.Modes[mode] = metrics
	}
	return report
}

func writeExperimentCSV(path string, rows []ExperimentRow, metrics MetricsReport) error {
	file, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create experiment CSV: %w", err)
	}
	writer := csv.NewWriter(file)
	if err := writer.Write(experimentCSVHeader); err != nil {
		_ = file.Close()
		return fmt.Errorf("write experiment CSV header: %w", err)
	}
	for _, row := range rows {
		record := []string{
			row.ID,
			row.Label,
			row.ViolationType,
			row.Mode,
			row.Predicted,
			row.Expected,
			strconv.FormatBool(row.Correct),
			row.RuleFired,
			row.BlockedStage,
			strconv.FormatFloat(row.LatencyMS, 'f', 6, 64),
			disabledRuleIDs(metrics.DisabledRules),
			strings.Join(metrics.DisabledRuleFamilies, ";"),
			metrics.RegistryHashAfter,
			metrics.ProductionFailClosedCaveat,
		}
		if err := writer.Write(record); err != nil {
			_ = file.Close()
			return fmt.Errorf("write experiment CSV row %s/%s: %w", row.ID, row.Mode, err)
		}
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		_ = file.Close()
		return fmt.Errorf("flush experiment CSV: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close experiment CSV: %w", err)
	}
	return nil
}

func disabledNoEvaluatorRules(bundle *coreregistry.Bundle) ([]DisabledEvaluationRule, []string) {
	rules := []DisabledEvaluationRule{}
	familySet := map[string]struct{}{}
	for _, rule := range bundle.Rules.GetAllRules() {
		if rule.Enabled || workflowvalidator.ClassifyRuleFamily(rule.RuleType) != workflowvalidator.RuleFamilyNoEvaluator {
			continue
		}
		family := strings.ToLower(strings.TrimSpace(rule.RuleType))
		rules = append(rules, DisabledEvaluationRule{RuleID: rule.RuleID, Family: family})
		familySet[family] = struct{}{}
	}
	sort.Slice(rules, func(i, j int) bool { return rules[i].RuleID < rules[j].RuleID })
	families := make([]string, 0, len(familySet))
	for family := range familySet {
		families = append(families, family)
	}
	sort.Strings(families)
	return rules, families
}

func disabledRuleIDs(rules []DisabledEvaluationRule) string {
	ids := make([]string, 0, len(rules))
	for _, rule := range rules {
		ids = append(ids, rule.RuleID)
	}
	return strings.Join(ids, ";")
}

func fileSHA256(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func writeExperimentMetrics(path string, metrics MetricsReport) error {
	raw, err := json.MarshalIndent(metrics, "", "  ")
	if err != nil {
		return fmt.Errorf("encode experiment metrics: %w", err)
	}
	raw = append(raw, '\n')
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		return fmt.Errorf("write experiment metrics: %w", err)
	}
	return nil
}

func FormatMetricsTable(metrics MetricsReport) string {
	var output strings.Builder
	output.WriteString("MODE      TP  FP  TN  FN  RECALL  PRECISION  FNR     F1      MEAN_LATENCY_MS\n")
	for _, mode := range []string{ModeGateOn, ModeGateOff} {
		item := metrics.Modes[mode]
		fmt.Fprintf(&output, "%-9s %3d %3d %3d %3d  %.4f  %.4f     %.4f  %.4f  %.4f\n", mode, item.TP, item.FP, item.TN, item.FN, item.Recall, item.Precision, item.FalseNegativeRate, item.F1, item.MeanLatencyMS)
		keys := make([]string, 0, len(item.PerViolationTypeRecall))
		for key := range item.PerViolationTypeRecall {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			fmt.Fprintf(&output, "  recall[%s]=%.4f\n", key, item.PerViolationTypeRecall[key])
		}
	}
	fmt.Fprintf(&output, "Known caveat: %s\n", metrics.KnownCaveat)
	return output.String()
}

func ratio(numerator, denominator int) float64 {
	if denominator == 0 {
		return 0
	}
	return float64(numerator) / float64(denominator)
}

func uniqueSortedStrings(values []string) []string {
	seen := map[string]struct{}{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			seen[value] = struct{}{}
		}
	}
	out := make([]string, 0, len(seen))
	for value := range seen {
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

type experimentSpyTool struct {
	mu      sync.Mutex
	actions []string
}

func (s *experimentSpyTool) Name() string { return "experiment.spy" }
func (s *experimentSpyTool) Description() string {
	return "records would-execute decisions without external side effects"
}
func (s *experimentSpyTool) ExperimentNoExternalDispatch() {}
func (s *experimentSpyTool) Execute(_ context.Context, capability workflowvalidator.DispatchCapability, params map[string]interface{}) (map[string]interface{}, error) {
	action := capability.Action()
	if action == "" {
		action = strings.TrimSpace(fmt.Sprint(params["_action"]))
	}
	s.mu.Lock()
	s.actions = append(s.actions, action)
	s.mu.Unlock()
	return map[string]interface{}{"ok": true, "would_execute": action}, nil
}

func (s *experimentSpyTool) CallCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.actions)
}

func (s *experimentSpyTool) Executed(action string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, called := range s.actions {
		if called == action {
			return true
		}
	}
	return false
}
