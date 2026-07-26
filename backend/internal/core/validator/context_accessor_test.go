package validator

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
)

func TestSensitiveAccessorMatchesScanBehaviour(t *testing.T) {
	fragments := SensitiveFieldNames()
	accessorSet := make(map[string]struct{}, len(fragments))
	for _, fragment := range fragments {
		if _, duplicate := accessorSet[fragment]; duplicate {
			t.Fatalf("SensitiveFieldNames contains duplicate %q", fragment)
		}
		accessorSet[fragment] = struct{}{}
		if !containsSensitiveKey(map[string]interface{}{"request_" + fragment + "_value": "test"}) {
			t.Fatalf("real sensitive-key scan did not flag accessor fragment %q", fragment)
		}
	}

	for _, fragment := range inlineSensitiveFragments(t) {
		if _, exposed := accessorSet[fragment]; !exposed {
			t.Fatalf("real sensitive-key scan includes %q but SensitiveFieldNames omits it", fragment)
		}
		if !containsSensitiveKey(map[string]interface{}{"request_" + fragment + "_value": "test"}) {
			t.Fatalf("inline sensitive fragment %q is not flagged by the real scan", fragment)
		}
	}
}

func inlineSensitiveFragments(t *testing.T) []string {
	t.Helper()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current test source")
	}
	sourcePath := filepath.Join(filepath.Dir(currentFile), "registry_validator.go")
	file, err := parser.ParseFile(token.NewFileSet(), sourcePath, nil, 0)
	if err != nil {
		t.Fatalf("parse validator source: %v", err)
	}

	var fragments []string
	ast.Inspect(file, func(node ast.Node) bool {
		declaration, ok := node.(*ast.FuncDecl)
		if !ok || declaration.Name.Name != "isSensitiveKey" {
			return true
		}
		ast.Inspect(declaration.Body, func(inner ast.Node) bool {
			assignment, ok := inner.(*ast.AssignStmt)
			if !ok || len(assignment.Lhs) != 1 || len(assignment.Rhs) != 1 {
				return true
			}
			identifier, ok := assignment.Lhs[0].(*ast.Ident)
			if !ok || identifier.Name != "sensitive" {
				return true
			}
			literal, ok := assignment.Rhs[0].(*ast.CompositeLit)
			if !ok {
				return true
			}
			for _, element := range literal.Elts {
				value, ok := element.(*ast.BasicLit)
				if !ok || value.Kind != token.STRING {
					continue
				}
				fragment, unquoteErr := strconv.Unquote(value.Value)
				if unquoteErr != nil {
					t.Fatalf("decode sensitive fragment %s: %v", value.Value, unquoteErr)
				}
				fragments = append(fragments, fragment)
			}
			return false
		})
		return false
	})
	if len(fragments) == 0 {
		t.Fatal("could not locate the sensitive inline literal used by isSensitiveKey")
	}
	return fragments
}
