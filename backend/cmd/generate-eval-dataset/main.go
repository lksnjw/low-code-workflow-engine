package main

import (
	"flag"
	"fmt"
	"log"

	eval "github.com/sanjeewa/agentic-orchestrator/dataset/eval"
)

func main() {
	toolRegistry := flag.String("tool-registry", "./configs/registries/all_tools_master_registry.json", "path to the real tool registry")
	ruleRegistry := flag.String("rule-registry", "./configs/registries/all_rules_master_registry.json", "path to the real rule registry")
	output := flag.String("output", "./dataset/eval", "output directory")
	flag.Parse()

	summary, err := eval.Generate(*toolRegistry, *ruleRegistry, *output)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(eval.FormatSummary(summary))
}
