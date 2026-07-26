package importer

import (
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"sort"
	"strings"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
)

var toolNamePattern = regexp.MustCompile(`^[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*){2,}$`)

type ruleContract struct {
	Operators          map[string]bool
	EnforcementActions map[string]bool
	ValueKind          string
}

// These contracts are transcribed from RegistryValidator.evaluateRules and
// its evaluator methods. cache_safety is deliberately absent because the
// validator switch has no evaluator or dedicated check for that family.
var implementedRuleContracts = map[string]ruleContract{
	"rbac": {
		Operators: map[string]bool{"==": true}, EnforcementActions: map[string]bool{"block": true}, ValueKind: "string",
	},
	"parameter_required": {
		Operators: map[string]bool{"exists": true}, EnforcementActions: map[string]bool{"block": true}, ValueKind: "string_array",
	},
	"amount_threshold": {
		Operators: numericOperators(), EnforcementActions: map[string]bool{"block": true, "require_human_approval": true}, ValueKind: "number",
	},
	"quantity_threshold": {
		Operators: numericOperators(), EnforcementActions: map[string]bool{"block": true, "require_human_approval": true}, ValueKind: "number",
	},
	"process_order": {
		Operators: map[string]bool{"before": true}, EnforcementActions: map[string]bool{"block": true}, ValueKind: "ordered_string_array",
	},
	"separation_of_duties": {
		Operators: map[string]bool{"!=": true}, EnforcementActions: map[string]bool{"block": true}, ValueKind: "null",
	},
	"risk_escalation": {
		Operators: map[string]bool{">=": true}, EnforcementActions: map[string]bool{"require_human_approval": true}, ValueKind: "risk",
	},
	"audit": {
		Operators: map[string]bool{"==": true}, EnforcementActions: map[string]bool{"write_audit_log": true}, ValueKind: "bool",
	},
	"data_confidentiality": {
		Operators: map[string]bool{"not_exists": true}, EnforcementActions: map[string]bool{"block": true}, ValueKind: "string_array",
	},
	"execution_safety": {
		Operators: map[string]bool{"exists": true}, EnforcementActions: map[string]bool{"block": true}, ValueKind: "null",
	},
	"capability_gap": {
		Operators: map[string]bool{"!=": true}, EnforcementActions: map[string]bool{"require_schema_generation": true}, ValueKind: "string",
	},
}

func numericOperators() map[string]bool {
	return map[string]bool{">": true, ">=": true, "<": true, "<=": true, "==": true, "!=": true}
}

func validateTool(tool registry.Tool, line, index int) []RecordError {
	errorsFound := []RecordError{}
	add := func(field, reason string) {
		errorsFound = append(errorsFound, RecordError{RecordID: tool.ToolID, Line: line, Index: index, Field: field, Reason: reason})
	}
	if !toolNamePattern.MatchString(strings.TrimSpace(tool.Name)) {
		add("name", "must use the namespace domain.entity.action with at least three lowercase segments")
	}
	properties, ok := tool.InputSchema["properties"].(map[string]interface{})
	if !ok {
		add("input_schema.properties", "must be an object")
		return errorsFound
	}
	for name, raw := range properties {
		schema, ok := raw.(map[string]interface{})
		if !ok {
			add("input_schema.properties."+name, "must be a schema object with a concrete type")
			continue
		}
		parameterType, ok := schema["type"].(string)
		if !ok || strings.TrimSpace(parameterType) == "" {
			add("input_schema.properties."+name+".type", "declared parameters must have a concrete type")
		}
		if enum, exists := schema["enum"]; exists {
			values, ok := enum.([]interface{})
			if !ok {
				if stringsValue, stringsOK := enum.([]string); stringsOK {
					if len(stringsValue) == 0 {
						add("input_schema.properties."+name+".enum", "declared enums must contain at least one value")
					}
				} else {
					add("input_schema.properties."+name+".enum", "must be an array")
				}
			} else if len(values) == 0 {
				add("input_schema.properties."+name+".enum", "declared enums must contain at least one value")
			}
		}
	}
	for _, name := range append(append([]string{}, tool.RequiredParameters...), tool.OptionalParameters...) {
		if _, exists := properties[name]; !exists {
			add("input_schema.properties."+name, "declared parameter is not defined in input_schema.properties")
		}
	}
	return errorsFound
}

func validateRule(rule registry.Rule, tools []registry.Tool, line, index int) []RecordError {
	errorsFound := []RecordError{}
	add := func(field, reason string) {
		errorsFound = append(errorsFound, RecordError{RecordID: rule.RuleID, Line: line, Index: index, Field: field, Reason: reason})
	}
	contract, implemented := implementedRuleContracts[rule.RuleType]
	if !implemented {
		add("rule_type", fmt.Sprintf("%q has no implemented evaluator or dedicated check", rule.RuleType))
		return errorsFound
	}
	if !contract.Operators[rule.Condition.Operator] {
		add("condition.operator", fmt.Sprintf("%q is not implemented for rule type %s", rule.Condition.Operator, rule.RuleType))
	}
	if reason := validateConditionValue(contract.ValueKind, rule.Condition.Value); reason != "" {
		add("condition.value", reason)
	}
	if !contract.EnforcementActions[rule.EnforcementAction] {
		add("enforcement_action", fmt.Sprintf("%q is not honoured for rule type %s", rule.EnforcementAction, rule.RuleType))
	}
	if !ruleMatchesAnyTool(rule, tools) {
		add("applies_to_tools", "matches zero tools in the prospective registry")
	}
	return errorsFound
}

func validateConditionValue(kind string, value interface{}) string {
	switch kind {
	case "number":
		switch value.(type) {
		case float64, float32, int, int32, int64, json.Number:
			return ""
		default:
			return "must be numeric for this operator"
		}
	case "string":
		if text, ok := value.(string); !ok || strings.TrimSpace(text) == "" {
			return "must be a non-empty string for this operator"
		}
	case "risk":
		text, ok := value.(string)
		if !ok || !map[string]bool{"low": true, "medium": true, "high": true, "critical": true}[strings.ToLower(strings.TrimSpace(text))] {
			return "must be one of low, medium, high, or critical"
		}
	case "bool":
		if _, ok := value.(bool); !ok {
			return "must be a boolean for this operator"
		}
	case "null":
		if value != nil {
			return "must be null for this operator"
		}
	case "string_array", "ordered_string_array":
		values := interfaceStrings(value)
		minimum := 1
		if kind == "ordered_string_array" {
			minimum = 2
		}
		if len(values) < minimum {
			return fmt.Sprintf("must be an array containing at least %d non-empty string value(s)", minimum)
		}
	}
	return ""
}

func interfaceStrings(value interface{}) []string {
	switch typed := value.(type) {
	case []string:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			if strings.TrimSpace(item) != "" {
				out = append(out, item)
			}
		}
		return out
	case []interface{}:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			text, ok := item.(string)
			if !ok || strings.TrimSpace(text) == "" {
				return nil
			}
			out = append(out, text)
		}
		return out
	default:
		return nil
	}
}

func ruleMatchesAnyTool(rule registry.Rule, tools []registry.Tool) bool {
	if len(tools) == 0 {
		return false
	}
	if len(rule.AppliesToTools) == 0 {
		return true
	}
	for _, tool := range tools {
		for _, reference := range rule.AppliesToTools {
			if strings.EqualFold(strings.TrimSpace(reference), strings.TrimSpace(tool.ToolID)) ||
				strings.EqualFold(strings.TrimSpace(reference), strings.TrimSpace(tool.Name)) ||
				strings.EqualFold(strings.TrimSpace(reference), strings.TrimSpace(tool.MCPToolName)) {
				return true
			}
		}
	}
	return false
}

func fieldChanges(before, after interface{}) []FieldChange {
	beforeRaw, _ := json.Marshal(before)
	afterRaw, _ := json.Marshal(after)
	var beforeMap map[string]interface{}
	var afterMap map[string]interface{}
	_ = json.Unmarshal(beforeRaw, &beforeMap)
	_ = json.Unmarshal(afterRaw, &afterMap)
	keys := map[string]bool{}
	for key := range beforeMap {
		keys[key] = true
	}
	for key := range afterMap {
		keys[key] = true
	}
	names := make([]string, 0, len(keys))
	for key := range keys {
		names = append(names, key)
	}
	sort.Strings(names)
	changes := []FieldChange{}
	for _, name := range names {
		if !reflect.DeepEqual(beforeMap[name], afterMap[name]) {
			changes = append(changes, FieldChange{Field: name, Before: beforeMap[name], After: afterMap[name]})
		}
	}
	return changes
}
