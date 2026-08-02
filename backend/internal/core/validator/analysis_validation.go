package validator

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/structuredoutput"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

var analysisInputReference = regexp.MustCompile(`^\{\{\s*([a-zA-Z0-9_-]+)\.output(?:\.([a-zA-Z0-9_.-]+))?\s*\}\}$`)

func (v *RegistryValidator) validateAnalysisStep(blueprint models.WorkflowBlueprint, stepIndex int, result *CandidateValidationResult) {
	step := blueprint.Steps[stepIndex]
	if strings.TrimSpace(step.Instruction) == "" {
		result.SchemaOK = false
		result.addError("ANALYSIS_INSTRUCTION_REQUIRED", fmt.Sprintf("Analysis step %s requires instruction", step.ID))
	}
	if err := structuredoutput.ValidateSchema(step.OutputSchema); err != nil {
		result.SchemaOK = false
		result.addError("ANALYSIS_OUTPUT_SCHEMA_INVALID", fmt.Sprintf("Analysis step %s: %v", step.ID, err))
	}
	if step.MaxInputItems < 0 || step.MaxInputChars < 0 {
		result.SchemaOK = false
		result.addError("ANALYSIS_INPUT_LIMIT_INVALID", fmt.Sprintf("Analysis step %s input limits cannot be negative", step.ID))
	}

	matches := analysisInputReference.FindStringSubmatch(strings.TrimSpace(step.Input))
	if len(matches) == 0 {
		result.SchemaOK = false
		result.addError("ANALYSIS_INPUT_INVALID", fmt.Sprintf("Analysis step %s input must reference a prior step output", step.ID))
		return
	}
	sourceID := matches[1]
	sourceFound := false
	for priorIndex := 0; priorIndex < stepIndex; priorIndex++ {
		if blueprint.Steps[priorIndex].ID == sourceID {
			sourceFound = true
			break
		}
	}
	if !sourceFound {
		result.SchemaOK = false
		result.addError("ANALYSIS_INPUT_SOURCE_UNDECLARED", fmt.Sprintf("Analysis step %s input source %s is not a declared prior step", step.ID, sourceID))
		return
	}

	for _, rule := range v.Rules.GetEnabledRules() {
		if rule.RuleType != "data_confidentiality" {
			continue
		}
		fields, ok := parseDataConfidentialityRule(rule)
		if !ok {
			result.PolicyOK = false
			result.addRuleError(rule.RuleID, fmt.Sprintf("Data confidentiality rule %s has no deterministic evaluator", rule.RuleID))
			continue
		}
		result.addDeferredCheck(stepIndex, "input", rule.RuleID)
		if matches[2] != "" && fieldPathContainsForbidden(matches[2], fields) {
			result.PolicyOK = false
			result.addRuleError(rule.RuleID, message(rule, fmt.Sprintf("Analysis step %s references a field forbidden from model egress", step.ID)))
		}
	}
}

func parseDataConfidentialityRule(rule registry.Rule) ([]string, bool) {
	if rule.RuleType != "data_confidentiality" ||
		!strings.EqualFold(strings.TrimSpace(rule.Condition.Type), "sensitive_key") ||
		!strings.EqualFold(strings.TrimSpace(rule.Condition.Operator), "not_exists") ||
		!strings.EqualFold(strings.TrimSpace(rule.EnforcementAction), "block") {
		return nil, false
	}
	fields := interfaceSliceToStrings(rule.Condition.Value)
	if len(fields) == 0 {
		return nil, false
	}
	for index := range fields {
		fields[index] = strings.ToLower(strings.TrimSpace(fields[index]))
		if fields[index] == "" {
			return nil, false
		}
	}
	return fields, true
}

func fieldPathContainsForbidden(path string, fields []string) bool {
	for _, segment := range strings.FieldsFunc(strings.ToLower(path), func(r rune) bool { return r == '.' || r == '-' }) {
		if isSensitiveKey(segment) {
			return true
		}
		for _, forbidden := range fields {
			if segment == forbidden || strings.Contains(segment, forbidden) {
				return true
			}
		}
	}
	return false
}

// EvaluateAnalysisEgress applies the existing sensitive-key scanner plus the
// analysis-only data_confidentiality evaluator to the resolved payload.
func (v *RegistryValidator) EvaluateAnalysisEgress(action string, blueprint models.WorkflowBlueprint, stepIndex int, input interface{}, token *models.ValidationToken) *ResolvedPolicyViolation {
	checkedRuleIDs := []string{}
	var violation *ResolvedPolicyViolation
	if key, value, found := firstSensitiveEntry(input, "input"); found {
		violation = &ResolvedPolicyViolation{StepIndex: stepIndex, ParamKey: key, RuleID: "GLOBAL-SAFETY-002", Value: value, Reason: "resolved analysis input contains a sensitive credential-like key"}
	}

	if violation == nil && token != nil {
		for _, deferred := range token.DeferredChecks {
			if deferred.StepIndex != stepIndex || deferred.ParamKey != "input" {
				continue
			}
			for _, ruleID := range deferred.RuleIDs {
				checkedRuleIDs = append(checkedRuleIDs, ruleID)
				rule, ok := v.enabledRuleByID(ruleID)
				if !ok {
					violation = &ResolvedPolicyViolation{StepIndex: stepIndex, ParamKey: "input", RuleID: ruleID, Value: input, Reason: "deferred data confidentiality rule has no enabled evaluator"}
					break
				}
				fields, evaluable := parseDataConfidentialityRule(rule)
				if !evaluable {
					violation = &ResolvedPolicyViolation{StepIndex: stepIndex, ParamKey: "input", RuleID: ruleID, Value: input, Reason: "deferred data confidentiality rule has no evaluator"}
					break
				}
				if key, value, found := firstForbiddenField(input, "input", fields); found {
					violation = &ResolvedPolicyViolation{StepIndex: stepIndex, ParamKey: key, RuleID: ruleID, Value: value, Reason: message(rule, "resolved analysis input is forbidden from model egress")}
					break
				}
			}
			if violation != nil {
				break
			}
		}
	}

	contentHash := ""
	registryHash := v.RegistryHash()
	if token != nil {
		contentHash = token.WorkflowContentHash
		registryHash = token.RegistryHash
	}
	ruleResults := map[string]interface{}{
		"step_index":       stepIndex,
		"checked_rule_ids": uniqueStrings(checkedRuleIDs),
		"egress_scan":      violation == nil,
	}
	if violation != nil {
		ruleResults["failed_rule"] = violation.RuleID
		ruleResults["param_key"] = violation.ParamKey
		ruleResults["reason"] = violation.Reason
	}
	v.auditDecision(action, "runtime", violation == nil, contentHash, registryHash, ruleResults)
	return violation
}

func firstForbiddenField(value interface{}, path string, fields []string) (string, interface{}, bool) {
	switch typed := value.(type) {
	case map[string]interface{}:
		for key, item := range typed {
			itemPath := key
			if path != "" {
				itemPath = path + "." + key
			}
			if fieldPathContainsForbidden(key, fields) {
				return itemPath, item, true
			}
			if nestedKey, nestedValue, found := firstForbiddenField(item, itemPath, fields); found {
				return nestedKey, nestedValue, true
			}
		}
	case []interface{}:
		for index, item := range typed {
			itemPath := fmt.Sprintf("%s[%d]", path, index)
			if nestedKey, nestedValue, found := firstForbiddenField(item, itemPath, fields); found {
				return nestedKey, nestedValue, true
			}
		}
	}
	return "", nil, false
}
