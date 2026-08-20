//go:build experiment

package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/sanjeewa/agentic-orchestrator/dataset/eval"
)

func main() {
	datasetDir := flag.String("dataset-dir", filepath.Join("dataset", "eval"), "directory containing safe_workflows.jsonl and unsafe_workflows.jsonl")
	toolRegistry := flag.String("tool-registry", filepath.Join("configs", "registries", "all_tools_master_registry.json"), "tool registry JSON path")
	ruleRegistry := flag.String("rule-registry", filepath.Join("configs", "registries", "all_rules_master_registry.json"), "rule registry JSON path")
	outputDir := flag.String("output", "test-results", "experiment artifact output directory")
	flag.Parse()

	environment := os.Getenv("APP_ENV")
	if environment != "experiment" {
		fatal(fmt.Errorf("Baseline B is not enabled for APP_ENV=%q", environment))
	}
	cases, err := eval.LoadExperimentCases(
		filepath.Join(*datasetDir, eval.SafeFilename),
		filepath.Join(*datasetDir, eval.UnsafeFilename),
	)
	if err != nil {
		fatal(err)
	}
	report, err := eval.RunExperiment(context.Background(), eval.ExperimentConfig{
		Cases:            cases,
		ToolRegistryPath: *toolRegistry,
		RuleRegistryPath: *ruleRegistry,
		OutputDir:        *outputDir,
		Environment:      environment,
	})
	if err != nil {
		fatal(err)
	}

	fmt.Printf("cases=%d rows=%d\n", report.Metrics.Cases, report.Metrics.Rows)
	fmt.Print(eval.FormatMetricsTable(report.Metrics))
	fmt.Printf("CSV: %s\n", filepath.Join(*outputDir, eval.ExperimentCSVFilename))
	fmt.Printf("Metrics: %s\n", filepath.Join(*outputDir, eval.ExperimentMetricsFile))
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "experiment failed:", err)
	os.Exit(1)
}
