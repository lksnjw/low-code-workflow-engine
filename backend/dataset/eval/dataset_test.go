package eval

import (
	"bufio"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestGeneratedDatasetSanity(t *testing.T) {
	safe := loadCases(t, SafeFilename)
	unsafe := loadCases(t, UnsafeFilename)
	if len(safe) < 60 {
		t.Fatalf("safe case count=%d, want at least 60", len(safe))
	}
	if len(unsafe) < 60 {
		t.Fatalf("unsafe case count=%d, want at least 60", len(unsafe))
	}

	ids := map[string]string{}
	for _, group := range [][]Case{safe, unsafe} {
		for _, item := range group {
			if strings.TrimSpace(item.ID) == "" {
				t.Fatal("case has an empty id")
			}
			if previous, exists := ids[item.ID]; exists {
				t.Fatalf("id collision %q in %s and %s", item.ID, previous, item.Label)
			}
			ids[item.ID] = item.Label
			if strings.TrimSpace(item.YAML) == "" || strings.TrimSpace(item.UserRole) == "" {
				t.Fatalf("case %s is missing yaml or user_role", item.ID)
			}
		}
	}
	for _, item := range safe {
		if item.Label != "safe" || item.Expected != "allow" {
			t.Fatalf("safe file contains inconsistent case %+v", item)
		}
	}
	for _, item := range unsafe {
		if item.Label != "unsafe" || item.Expected != "block" {
			t.Fatalf("unsafe file contains inconsistent case %+v", item)
		}
		if strings.TrimSpace(item.ViolationType) == "" || strings.TrimSpace(item.ExpectedRule) == "" {
			t.Fatalf("unsafe case %s is missing violation_type or expected_rule", item.ID)
		}
		if item.ViolationType == "over_threshold_variable" {
			if !strings.Contains(item.YAML, "{{input.amount}}") {
				t.Fatalf("variable threshold case %s does not use {{input.amount}}", item.ID)
			}
			amount, ok := numericInput(item.Input["amount"])
			if !ok || amount <= 100 {
				t.Fatalf("variable threshold case %s has non-violating input %+v", item.ID, item.Input)
			}
		}
	}

	wantBreakdown := map[string]int{
		"unknown_tool":            10,
		"over_threshold_literal":  10,
		"over_threshold_variable": 10,
		"rbac_violation":          10,
		"missing_approval":        8,
		"self_approval":           6,
		"credential_in_param":     6,
	}
	got := countByType(unsafe)
	for violationType, count := range wantBreakdown {
		if got[violationType] != count {
			t.Errorf("unsafe %s count=%d, want %d", violationType, got[violationType], count)
		}
	}
}

func loadCases(t *testing.T, path string) []Case {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer file.Close()

	cases := []Case{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for line := 1; scanner.Scan(); line++ {
		var item Case
		if err := json.Unmarshal(scanner.Bytes(), &item); err != nil {
			t.Fatalf("parse %s line %d: %v", path, line, err)
		}
		cases = append(cases, item)
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan %s: %v", path, err)
	}
	return cases
}

func numericInput(value interface{}) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	default:
		return 0, false
	}
}
