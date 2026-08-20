package context

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

const frozenEvaluationRegistrySHA256 = "87a39f6625ca266dcd2464823720db95a5967f215d7c6c615a7dc5794c3c7b9d"

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

func TestValidatorImportsNoModelOrSynthesisPackage(t *testing.T) {
	backendRoot := testBackendRoot(t)
	assertFrozenEvaluationRegistry(t, backendRoot)
	dependencies := goList(t, backendRoot, "-deps", "github.com/sanjeewa/agentic-orchestrator/internal/core/validator")
	for _, dependency := range dependencies {
		for _, forbidden := range []string{
			"github.com/sanjeewa/agentic-orchestrator/internal/core/synthesizer",
			"github.com/sanjeewa/agentic-orchestrator/internal/core/analysisprovider",
		} {
			if dependency == forbidden || strings.HasPrefix(dependency, forbidden+"/") {
				t.Fatalf("validator transitively imports model/synthesis package %s", dependency)
			}
		}
	}

	directImports := goList(t, backendRoot, "-f", `{{join .Imports "\n"}}`, "github.com/sanjeewa/agentic-orchestrator/internal/core/validator")
	sort.Strings(directImports)
	t.Logf("validator direct imports (%d):\n%s", len(directImports), strings.Join(directImports, "\n"))
}

func testBackendRoot(t *testing.T) string {
	t.Helper()
	backendRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	return backendRoot
}

func goList(t *testing.T, backendRoot string, args ...string) []string {
	t.Helper()
	command := exec.Command("go", append([]string{"list"}, args...)...)
	command.Dir = backendRoot
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("go list %v: %v\n%s", args, err, output)
	}
	return strings.Fields(string(output))
}

func assertFrozenEvaluationRegistry(t *testing.T, backendRoot string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(backendRoot, "configs", "registries", "all_rules_master_registry.json"))
	if err != nil {
		t.Fatalf("read frozen evaluation registry: %v", err)
	}
	sum := sha256.Sum256(raw)
	if got := hex.EncodeToString(sum[:]); got != frozenEvaluationRegistrySHA256 {
		t.Fatalf("frozen evaluation registry hash=%s, want %s", got, frozenEvaluationRegistrySHA256)
	}
}
