package company

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidatorDoesNotDependOnCompanyProfile(t *testing.T) {
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
		if dependency == "github.com/sanjeewa/agentic-orchestrator/internal/core/company" {
			t.Fatalf("policy boundary violated: validator transitively imports CompanyProfile context package\n%s", output)
		}
	}
}
