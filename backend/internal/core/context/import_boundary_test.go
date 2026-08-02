package context

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidatorDoesNotDependOnContextPackage(t *testing.T) {
	backendRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command("go", "list", "-deps", "github.com/sanjeewa/agentic-orchestrator/internal/core/validator")
	command.Dir = backendRoot
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("walk validator transitive imports: %v\n%s", err, output)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "github.com/sanjeewa/agentic-orchestrator/internal/core/context" {
			t.Fatalf("deterministic validation boundary violated: validator transitively imports generated Markdown context package\n%s", output)
		}
	}
}

func TestRunnerDoesNotDependOnContextPackage(t *testing.T) {
	backendRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command("go", "list", "-deps", "github.com/sanjeewa/agentic-orchestrator/internal/core/runner")
	command.Dir = backendRoot
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("walk runner transitive imports: %v\n%s", err, output)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "github.com/sanjeewa/agentic-orchestrator/internal/core/context" {
			t.Fatalf("deterministic execution boundary violated: runner transitively imports generated Markdown context package\n%s", output)
		}
	}
}
