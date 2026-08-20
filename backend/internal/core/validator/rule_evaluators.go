package validator

import (
	"sort"
	"strings"
)

// RuleEvaluatorStatus classifies whether a registry rule family has a real,
// deterministic evaluator in the validation gate.
type RuleEvaluatorStatus string

const (
	RuleFamilyEvaluated   RuleEvaluatorStatus = "EVALUATED"
	RuleFamilyNoEvaluator RuleEvaluatorStatus = "NO_EVALUATOR"
)

// UnevaluatedRule identifies an enabled registry rule that the gate cannot
// evaluate. It is suitable for startup diagnostics and machine-readable logs.
type UnevaluatedRule struct {
	RuleID string `json:"rule_id"`
	Family string `json:"family"`
}

// ruleFamilyEvaluatorStatus is the exhaustive classification for every rule
// family accepted by the registry data and importer contracts.
var ruleFamilyEvaluatorStatus = map[string]RuleEvaluatorStatus{
	"amount_threshold":     RuleFamilyEvaluated,
	"audit":                RuleFamilyEvaluated,
	"capability_gap":       RuleFamilyNoEvaluator,
	"cache_safety":         RuleFamilyNoEvaluator,
	"data_confidentiality": RuleFamilyEvaluated,
	"execution_safety":     RuleFamilyNoEvaluator,
	"parameter_required":   RuleFamilyEvaluated,
	"process_order":        RuleFamilyEvaluated,
	"quantity_threshold":   RuleFamilyEvaluated,
	"rbac":                 RuleFamilyEvaluated,
	"risk_escalation":      RuleFamilyEvaluated,
	"separation_of_duties": RuleFamilyEvaluated,
}

// ClassifyRuleFamily returns NO_EVALUATOR for an unknown family so registry
// extensions fail closed until a real evaluator and classification are added.
func ClassifyRuleFamily(family string) RuleEvaluatorStatus {
	status, known := ruleFamilyEvaluatorStatus[strings.ToLower(strings.TrimSpace(family))]
	if !known {
		return RuleFamilyNoEvaluator
	}
	return status
}

// EnabledRulesWithoutEvaluator lists every enabled rule that will fail closed.
func (v *RegistryValidator) EnabledRulesWithoutEvaluator() []UnevaluatedRule {
	gaps := []UnevaluatedRule{}
	for _, rule := range v.Rules.GetEnabledRules() {
		if ClassifyRuleFamily(rule.RuleType) == RuleFamilyEvaluated {
			continue
		}
		gaps = append(gaps, UnevaluatedRule{RuleID: rule.RuleID, Family: rule.RuleType})
	}
	sort.Slice(gaps, func(i, j int) bool {
		if gaps[i].Family == gaps[j].Family {
			return gaps[i].RuleID < gaps[j].RuleID
		}
		return gaps[i].Family < gaps[j].Family
	})
	return gaps
}
