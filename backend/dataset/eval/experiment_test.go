package eval

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

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
		for _, column := range []int{0, 1, 2, 3, 4, 5, 6, 7, 8, 9} {
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
	for _, mode := range []string{ModeGateOn, ModeGateOff} {
		if _, ok := metrics.Modes[mode]; !ok {
			t.Fatalf("metrics missing mode %s", mode)
		}
	}
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
