//go:build experiment

package eval

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"go.uber.org/zap"
)

const frozenEvaluationRegistrySHA256 = "87a39f6625ca266dcd2464823720db95a5967f215d7c6c615a7dc5794c3c7b9d"

type gateVerdictEvidence struct {
	ID           string
	Label        string
	Mode         string
	Predicted    string
	Expected     string
	Correct      bool
	RuleIDs      []string
	BlockedStage string
}

type provenanceGateEvidence struct {
	PlanPassed       bool
	TokenIssued      bool
	SchemaOK         bool
	ToolValidityOK   bool
	ParametersOK     bool
	RBACOK           bool
	PolicyOK         bool
	ProcessOrderOK   bool
	RiskOK           bool
	Errors           []string
	Warnings         []string
	FailedRules      []string
	EstimatedRisk    string
	StepCount        int
	ToolRisks        map[string]string
	DeferredChecks   []models.DeferredCheck
	FinalGateVerdict gateVerdictEvidence
}

func TestExperimentHarnessProducesCSVAndMetricsForFourCases(t *testing.T) {
	cases, err := LoadExperimentCases(SafeFilename, UnsafeFilename)
	if err != nil {
		t.Fatalf("load cases: %v", err)
	}
	selected := selectCasesByID(t, cases,
		"safe_unknown_tool_01",
		"safe_threshold_variable_01",
		"unsafe_unknown_tool_01",
		"unsafe_threshold_variable_01",
	)
	outputDir := t.TempDir()
	report, err := RunExperiment(context.Background(), ExperimentConfig{
		Cases:            selected,
		ToolRegistryPath: filepath.Join("..", "..", "configs", "registries", "all_tools_master_registry.json"),
		RuleRegistryPath: filepath.Join("..", "..", "configs", "registries", "all_rules_master_registry.json"),
		OutputDir:        outputDir,
		Environment:      "experiment",
	})
	if err != nil {
		t.Fatalf("run experiment: %v", err)
	}
	if len(report.Rows) != 8 {
		t.Fatalf("result rows=%d, want 8", len(report.Rows))
	}

	csvFile, err := os.Open(filepath.Join(outputDir, ExperimentCSVFilename))
	if err != nil {
		t.Fatalf("open CSV: %v", err)
	}
	records, err := csv.NewReader(csvFile).ReadAll()
	_ = csvFile.Close()
	if err != nil {
		t.Fatalf("read CSV: %v", err)
	}
	if len(records) != 9 {
		t.Fatalf("CSV records=%d, want header plus 8 rows", len(records))
	}
	if !reflect.DeepEqual(records[0], experimentCSVHeader) {
		t.Fatalf("CSV header=%v, want %v", records[0], experimentCSVHeader)
	}
	for index, record := range records[1:] {
		if len(record) != len(experimentCSVHeader) {
			t.Fatalf("CSV row %d columns=%d, want %d", index+1, len(record), len(experimentCSVHeader))
		}
		for column := range record {
			if record[column] == "" {
				t.Fatalf("CSV row %d column %s is empty", index+1, experimentCSVHeader[column])
			}
		}
	}

	rawMetrics, err := os.ReadFile(filepath.Join(outputDir, ExperimentMetricsFile))
	if err != nil {
		t.Fatalf("read metrics: %v", err)
	}
	var metrics MetricsReport
	if err := json.Unmarshal(rawMetrics, &metrics); err != nil {
		t.Fatalf("decode metrics: %v", err)
	}
	if metrics.Cases != 4 || metrics.Rows != 8 {
		t.Fatalf("metrics counts cases=%d rows=%d, want 4 and 8", metrics.Cases, metrics.Rows)
	}
	wantDisabled := []DisabledEvaluationRule{
		{RuleID: "CAP-GAP-001", Family: "capability_gap"},
		{RuleID: "GLOBAL-SAFETY-001", Family: "execution_safety"},
	}
	if !reflect.DeepEqual(metrics.DisabledRules, wantDisabled) {
		t.Fatalf("disabled rules=%+v, want %+v", metrics.DisabledRules, wantDisabled)
	}
	if !reflect.DeepEqual(metrics.DisabledRuleFamilies, []string{"capability_gap", "execution_safety"}) {
		t.Fatalf("disabled rule families=%v", metrics.DisabledRuleFamilies)
	}
	if metrics.RegistryHashBefore != EvaluationRegistryHashBefore || metrics.RegistryHashAfter == "" {
		t.Fatalf("registry hashes before=%q after=%q", metrics.RegistryHashBefore, metrics.RegistryHashAfter)
	}
	if metrics.ProductionFailClosedCaveat != ProductionEvaluatorCaveat {
		t.Fatalf("production caveat=%q", metrics.ProductionFailClosedCaveat)
	}
	for _, mode := range []string{ModeGateOn, ModeGateOff} {
		if _, ok := metrics.Modes[mode]; !ok {
			t.Fatalf("metrics missing mode %s", mode)
		}
	}
}

func TestGateVerdictsAreDeterministicAcrossRepeatedRuns(t *testing.T) {
	toolRegistryPath, ruleRegistryPath := evaluationRegistryPaths()
	assertFrozenEvaluationRegistry(t, ruleRegistryPath)
	cases, err := LoadExperimentCases(SafeFilename, UnsafeFilename)
	if err != nil {
		t.Fatalf("load cases: %v", err)
	}
	if len(cases) != 120 {
		t.Fatalf("evaluation case count=%d, want 120", len(cases))
	}
	sort.Slice(cases, func(i, j int) bool { return cases[i].ID < cases[j].ID })
	bundle, err := coreregistry.LoadBundle(toolRegistryPath, ruleRegistryPath, zap.NewNop())
	if err != nil {
		t.Fatalf("load frozen evaluation registries: %v", err)
	}

	baseline := make(map[string]gateVerdictEvidence, len(cases))
	identical := 0
	const runs = 5
	for run := 1; run <= runs; run++ {
		for _, item := range cases {
			row, runErr := runExperimentCase(context.Background(), bundle, item, ModeGateOn)
			if runErr != nil {
				t.Fatalf("run %d case %s: %v", run, item.ID, runErr)
			}
			current := verdictEvidence(row)
			if run == 1 {
				baseline[item.ID] = current
			} else if first := baseline[item.ID]; !reflect.DeepEqual(first, current) {
				t.Fatalf("run %d case %s differed: first=%+v current=%+v", run, item.ID, first, current)
			}
			identical++
		}
	}
	if want := runs * len(cases); identical != want {
		t.Fatalf("deterministic verdict count=%d/%d identical", identical, want)
	}
	t.Logf("A1 %d/%d identical registry_sha256=%s", identical, runs*len(cases), frozenEvaluationRegistrySHA256)
}

func TestGateVerdictIsInvariantToModelProvenance(t *testing.T) {
	toolRegistryPath, ruleRegistryPath := evaluationRegistryPaths()
	assertFrozenEvaluationRegistry(t, ruleRegistryPath)
	cases, err := LoadExperimentCases(SafeFilename, UnsafeFilename)
	if err != nil {
		t.Fatalf("load cases: %v", err)
	}
	bundle, err := coreregistry.LoadBundle(toolRegistryPath, ruleRegistryPath, zap.NewNop())
	if err != nil {
		t.Fatalf("load frozen evaluation registries: %v", err)
	}

	representatives := representativeCasesByViolationAndLabel(t, cases)
	for _, item := range representatives {
		if strings.Contains(item.YAML, "\nmetadata:") {
			t.Fatalf("case %s already has metadata; provenance test must add only model provenance", item.ID)
		}
		original, originalErr := evaluateProvenanceCase(bundle, item)
		if originalErr != nil {
			t.Fatalf("evaluate original case %s: %v", item.ID, originalErr)
		}
		withProvenance := item
		withProvenance.YAML = attachModelProvenance(item.YAML)
		provenanced, provenancedErr := evaluateProvenanceCase(bundle, withProvenance)
		if provenancedErr != nil {
			t.Fatalf("evaluate provenanced case %s: %v", item.ID, provenancedErr)
		}
		if !reflect.DeepEqual(original, provenanced) {
			t.Fatalf("case %s (%s/%s) changed under model provenance: original=%+v provenanced=%+v", item.ID, item.Label, item.ViolationType, original, provenanced)
		}
	}
	t.Logf("A2 %d/%d provenance-invariant registry_sha256=%s", len(representatives), len(representatives), frozenEvaluationRegistrySHA256)
}

func evaluationRegistryPaths() (string, string) {
	return filepath.Join("..", "..", "configs", "registries", "all_tools_master_registry.json"),
		filepath.Join("..", "..", "configs", "registries", "all_rules_master_registry.json")
}

func assertFrozenEvaluationRegistry(t *testing.T, ruleRegistryPath string) {
	t.Helper()
	hash, err := fileSHA256(ruleRegistryPath)
	if err != nil {
		t.Fatalf("hash frozen evaluation registry: %v", err)
	}
	if got := strings.TrimPrefix(hash, "sha256:"); got != frozenEvaluationRegistrySHA256 {
		t.Fatalf("frozen evaluation registry hash=%s, want %s", got, frozenEvaluationRegistrySHA256)
	}
}

func verdictEvidence(row ExperimentRow) gateVerdictEvidence {
	ruleIDs := []string{}
	if fired := strings.TrimSpace(row.RuleFired); fired != "" && fired != "none" {
		ruleIDs = strings.Split(fired, ";")
		sort.Strings(ruleIDs)
	}
	return gateVerdictEvidence{
		ID: row.ID, Label: row.Label, Mode: row.Mode, Predicted: row.Predicted,
		Expected: row.Expected, Correct: row.Correct, RuleIDs: ruleIDs, BlockedStage: row.BlockedStage,
	}
}

func representativeCasesByViolationAndLabel(t *testing.T, cases []Case) []Case {
	t.Helper()
	byKey := map[string]Case{}
	violationTypes := map[string]struct{}{}
	for _, item := range cases {
		violationTypes[item.ViolationType] = struct{}{}
		key := item.ViolationType + "/" + item.Label
		if _, exists := byKey[key]; !exists {
			byKey[key] = item
		}
	}
	types := make([]string, 0, len(violationTypes))
	for violationType := range violationTypes {
		types = append(types, violationType)
	}
	sort.Strings(types)
	representatives := make([]Case, 0, len(types)*2)
	for _, violationType := range types {
		for _, label := range []string{"safe", "unsafe"} {
			key := violationType + "/" + label
			item, ok := byKey[key]
			if !ok {
				t.Fatalf("missing %s representative for violation type %s", label, violationType)
			}
			representatives = append(representatives, item)
		}
	}
	return representatives
}

func attachModelProvenance(rawYAML string) string {
	return strings.TrimRight(rawYAML, "\r\n") + `
metadata:
  model_name: structural-provenance-test
  model_version: pinned-test-version
  provider: openai_compatible
`
}

func evaluateProvenanceCase(bundle *coreregistry.Bundle, item Case) (provenanceGateEvidence, error) {
	gate := workflowvalidator.NewRegistryValidator(bundle.Tools, bundle.Rules, repository.NewStore())
	token, result, err := gate.ValidateAndIssueToken("provenance."+item.ID, item.YAML, item.UserRole)
	if err != nil {
		return provenanceGateEvidence{}, err
	}
	row, err := runExperimentCase(context.Background(), bundle, item, ModeGateOn)
	if err != nil {
		return provenanceGateEvidence{}, fmt.Errorf("evaluate final gate verdict: %w", err)
	}
	return provenanceGateEvidence{
		PlanPassed: result.Passed, TokenIssued: token != nil, SchemaOK: result.SchemaOK,
		ToolValidityOK: result.ToolValidityOK, ParametersOK: result.ParametersOK, RBACOK: result.RBACOK,
		PolicyOK: result.PolicyOK, ProcessOrderOK: result.ProcessOrderOK, RiskOK: result.RiskOK,
		Errors: append([]string{}, result.Errors...), Warnings: append([]string{}, result.Warnings...),
		FailedRules: append([]string{}, result.FailedRules...), EstimatedRisk: result.EstimatedRisk,
		StepCount: result.StepCount, ToolRisks: result.ToolRisks,
		DeferredChecks: append([]models.DeferredCheck{}, result.DeferredChecks...), FinalGateVerdict: verdictEvidence(row),
	}, nil
}

func selectCasesByID(t *testing.T, cases []Case, ids ...string) []Case {
	t.Helper()
	byID := map[string]Case{}
	for _, item := range cases {
		byID[item.ID] = item
	}
	selected := make([]Case, 0, len(ids))
	for _, id := range ids {
		item, ok := byID[id]
		if !ok {
			t.Fatalf("case %s not found", id)
		}
		selected = append(selected, item)
	}
	return selected
}
