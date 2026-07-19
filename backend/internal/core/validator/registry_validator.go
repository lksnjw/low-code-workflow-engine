package validator

import (
	"crypto/hmac"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
	"strings"
	"time"

	playground "github.com/go-playground/validator/v10"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/pkg/parser"
	"gopkg.in/yaml.v3"
)

type CandidateValidationResult struct {
	CandidateID      string                    `json:"candidate_id"`
	Passed           bool                      `json:"passed"`
	Score            float64                   `json:"score"`
	SchemaOK         bool                      `json:"schema_ok"`
	ToolValidityOK   bool                      `json:"tool_validity_ok"`
	ParametersOK     bool                      `json:"parameters_ok"`
	RBACOK           bool                      `json:"rbac_ok"`
	PolicyOK         bool                      `json:"policy_ok"`
	ProcessOrderOK   bool                      `json:"process_order_ok"`
	RiskOK           bool                      `json:"risk_ok"`
	Errors           []string                  `json:"errors"`
	Warnings         []string                  `json:"warnings"`
	FailedRules      []string                  `json:"failed_rules"`
	RegistryVersions registry.RegistryVersions `json:"registry_versions"`
	EstimatedRisk    string                    `json:"estimated_risk_level"`
	StepCount        int                       `json:"step_count"`
	ParsedWorkflow   *models.WorkflowBlueprint `json:"-"`
	ToolRisks        map[string]string         `json:"tool_risks,omitempty"`
	Metadata         map[string]interface{}    `json:"metadata,omitempty"`
	DeferredChecks   []models.DeferredCheck    `json:"deferred_checks,omitempty"`
}

type RegistryValidator struct {
	Tools    *registry.ToolRegistry
	Rules    *registry.RuleRegistry
	Store    *repository.Store
	validate *playground.Validate
	tokenKey [32]byte
}

func NewRegistryValidator(tools *registry.ToolRegistry, rules *registry.RuleRegistry, store *repository.Store) *RegistryValidator {
	if tools == nil {
		panic("registry validator requires a tool registry")
	}
	if rules == nil {
		panic("registry validator requires a rule registry")
	}
	if store == nil {
		panic("registry validator requires an audit store")
	}
	validator := &RegistryValidator{Tools: tools, Rules: rules, Store: store, validate: playground.New()}
	if _, err := cryptorand.Read(validator.tokenKey[:]); err != nil {
		panic("registry validator cannot initialize validation-token proof key: " + err.Error())
	}
	return validator
}

func (v *RegistryValidator) ValidateCandidate(candidateID, rawYAML, userRole string) CandidateValidationResult {
	_, result, _ := v.ValidateAndIssueToken(candidateID, rawYAML, userRole)
	return *result
}

// ValidateAndIssueToken runs the complete deterministic gate. It is the only
// code path that constructs a ValidationToken, and it does so only on success.
func (v *RegistryValidator) ValidateAndIssueToken(action, rawYAML, userRole string) (*models.ValidationToken, *CandidateValidationResult, error) {
	result := v.validateCandidate(action, rawYAML, userRole)
	contentHash := WorkflowContentHash(rawYAML)
	registryHash := v.RegistryHash()

	var token *models.ValidationToken
	if result.Passed {
		token = &models.ValidationToken{
			WorkflowContentHash: contentHash,
			RegistryHash:        registryHash,
			PassedAt:            time.Now().UTC(),
			DeferredChecks:      cloneDeferredChecks(result.DeferredChecks),
		}
		token.Proof = v.signToken(token)
	}
	v.auditDecision(action, userRole, result.Passed, contentHash, registryHash, map[string]interface{}{
		"schema_ok":        result.SchemaOK,
		"tool_validity_ok": result.ToolValidityOK,
		"parameters_ok":    result.ParametersOK,
		"rbac_ok":          result.RBACOK,
		"policy_ok":        result.PolicyOK,
		"process_order_ok": result.ProcessOrderOK,
		"risk_ok":          result.RiskOK,
		"failed_rules":     append([]string{}, result.FailedRules...),
		"errors":           append([]string{}, result.Errors...),
		"deferred_checks":  cloneDeferredChecks(result.DeferredChecks),
	})
	return token, &result, nil
}

// VerifyToken proves that the token was issued by this validator instance and
// that none of its gate-bound fields or deferred checks were modified.
func (v *RegistryValidator) VerifyToken(token *models.ValidationToken) bool {
	if token == nil || token.Proof == "" {
		return false
	}
	expected := v.signToken(token)
	provided, err := hex.DecodeString(token.Proof)
	if err != nil {
		return false
	}
	expectedBytes, err := hex.DecodeString(expected)
	if err != nil {
		return false
	}
	return hmac.Equal(provided, expectedBytes)
}

func (v *RegistryValidator) validateCandidate(candidateID, rawYAML, userRole string) CandidateValidationResult {
	result := CandidateValidationResult{
		CandidateID:      candidateID,
		SchemaOK:         true,
		ToolValidityOK:   true,
		ParametersOK:     true,
		RBACOK:           true,
		PolicyOK:         true,
		ProcessOrderOK:   true,
		RiskOK:           true,
		Errors:           []string{},
		Warnings:         []string{},
		FailedRules:      []string{},
		RegistryVersions: registry.RegistryVersions{Tools: v.Tools.Version(), Rules: v.Rules.Version()},
		EstimatedRisk:    "low",
		ToolRisks:        map[string]string{},
		Metadata:         map[string]interface{}{},
		DeferredChecks:   []models.DeferredCheck{},
	}

	blueprint, err := ParseWorkflowYAMLStrict(rawYAML)
	if err != nil {
		result.SchemaOK = false
		result.addError("YAML_PARSE_ERROR", err.Error())
		result.finish()
		return result
	}
	result.ParsedWorkflow = &blueprint
	result.StepCount = len(blueprint.Steps)

	if err := v.validate.Struct(blueprint); err != nil {
		result.SchemaOK = false
		result.addError("SCHEMA_INVALID", fmt.Sprintf("YAML failed schema validation: %v", err))
	}
	if strings.TrimSpace(blueprint.Description) == "" {
		result.SchemaOK = false
		result.addError("SCHEMA_DESCRIPTION_REQUIRED", "description is required for generated workflow candidates")
	}

	stepsByAction := map[string][]int{}
	usedTools := []registry.Tool{}
	for index, step := range blueprint.Steps {
		action := strings.TrimSpace(step.Action)
		stepsByAction[strings.ToLower(action)] = append(stepsByAction[strings.ToLower(action)], index)
		tool, ok := v.Tools.FindToolByName(action)
		if !ok {
			result.ToolValidityOK = false
			result.addRuleError("GLOBAL-SAFETY-001", fmt.Sprintf("Unknown or hallucinated tool %q in step %s", action, step.ID))
			continue
		}
		usedTools = append(usedTools, tool)
		result.ToolRisks[tool.Name] = tool.RiskLevel
		result.EstimatedRisk = higherRisk(result.EstimatedRisk, tool.RiskLevel)

		v.validateToolStatus(tool, step, &result)
		v.validateRequiredParameters(tool, step, &result)
		v.validateRole(tool, userRole, step, &result)
		if containsSensitiveKey(step.Parameters) {
			result.PolicyOK = false
			result.addRuleError("GLOBAL-SAFETY-002", fmt.Sprintf("Step %s contains sensitive credential-like parameter", step.ID))
		}
		v.deferSensitiveTemplateChecks(index, step, tool, userRole, &result)
	}

	v.evaluateRules(blueprint, stepsByAction, usedTools, userRole, &result)
	result.finish()
	return result
}

func (v *RegistryValidator) validateToolStatus(tool registry.Tool, step models.WorkflowStepBlueprint, result *CandidateValidationResult) {
	switch strings.ToLower(strings.TrimSpace(tool.Status)) {
	case "", "active_mcp_schema_present":
		return
	case "mock_endpoint_available_schema_missing":
		result.ToolValidityOK = false
		result.addRuleError("CAP-GAP-001", fmt.Sprintf("Tool %s in step %s has mock endpoint but missing active MCP schema", tool.Name, step.ID))
	case "recommended_future_capability":
		result.ToolValidityOK = false
		result.addRuleError("CAP-GAP-001", fmt.Sprintf("Tool %s in step %s is a future capability and cannot execute directly", tool.Name, step.ID))
	default:
		result.ToolValidityOK = false
		result.addRuleError("CAP-GAP-001", fmt.Sprintf("Tool %s in step %s has unsupported status %q", tool.Name, step.ID, tool.Status))
	}
}

func (v *RegistryValidator) validateRequiredParameters(tool registry.Tool, step models.WorkflowStepBlueprint, result *CandidateValidationResult) {
	if step.Parameters == nil {
		step.Parameters = map[string]interface{}{}
	}
	for _, param := range tool.RequiredParameters {
		value, ok := step.Parameters[param]
		if !ok || isEmptyValue(value) {
			result.ParametersOK = false
			result.addError("MISSING_PARAMETER", fmt.Sprintf("Step %s using %s is missing required parameter %s", step.ID, tool.Name, param))
		}
	}
}

func (v *RegistryValidator) validateRole(tool registry.Tool, userRole string, step models.WorkflowStepBlueprint, result *CandidateValidationResult) {
	if roleIsAllowed(userRole, tool.AllowedRoles) {
		return
	}
	result.RBACOK = false
	result.addError("RBAC_DENIED", fmt.Sprintf("Role %q is not allowed to execute %s in step %s", userRole, tool.Name, step.ID))
}

func (v *RegistryValidator) evaluateRules(blueprint models.WorkflowBlueprint, stepsByAction map[string][]int, usedTools []registry.Tool, userRole string, result *CandidateValidationResult) {
	for _, rule := range v.Rules.GetEnabledRules() {
		if !ruleAppliesToCandidate(rule, usedTools, userRole, result.EstimatedRisk) {
			continue
		}
		switch rule.RuleType {
		case "rbac":
			v.evalRBACRule(rule, usedTools, userRole, result)
		case "parameter_required":
			v.evalParameterRule(rule, blueprint, result)
		case "amount_threshold", "quantity_threshold":
			v.evalThresholdRule(rule, blueprint, result)
		case "process_order":
			v.evalProcessOrderRule(rule, stepsByAction, result)
		case "separation_of_duties":
			v.evalSeparationOfDutiesRule(rule, blueprint, result)
		case "risk_escalation":
			v.evalRiskRule(rule, blueprint, usedTools, result)
		case "audit":
			v.evalAuditRule(rule, blueprint, usedTools, result)
		case "data_confidentiality", "execution_safety", "capability_gap", "cache_safety":
			// These are enforced by dedicated checks or documented for prompt grounding.
		default:
			result.Warnings = append(result.Warnings, "Unsupported governance rule type "+rule.RuleType+" for rule "+rule.RuleID)
		}
	}
}

func (v *RegistryValidator) evalRBACRule(rule registry.Rule, usedTools []registry.Tool, userRole string, result *CandidateValidationResult) {
	if len(rule.AppliesToRoles) == 0 || !roleMatchesAny(userRole, rule.AppliesToRoles) {
		return
	}
	for _, tool := range usedTools {
		if ruleAppliesToTool(rule, tool) && rule.EnforcementAction == "block" {
			result.RBACOK = false
			result.addRuleError(rule.RuleID, message(rule, fmt.Sprintf("Role %s is blocked from %s", userRole, tool.Name)))
		}
	}
}

func (v *RegistryValidator) evalParameterRule(rule registry.Rule, blueprint models.WorkflowBlueprint, result *CandidateValidationResult) {
	params := interfaceSliceToStrings(rule.Condition.Value)
	if len(params) == 0 {
		return
	}
	for stepIndex, step := range blueprint.Steps {
		tool, ok := v.Tools.FindToolByName(step.Action)
		if !ok || !ruleAppliesToTool(rule, tool) {
			continue
		}
		for _, param := range params {
			if step.Parameters == nil || isEmptyValue(step.Parameters[param]) {
				result.ParametersOK = false
				result.addRuleError(rule.RuleID, message(rule, fmt.Sprintf("Step %s missing parameter %s", step.ID, param)))
				continue
			}
			if containsUnresolvedTemplate(step.Parameters[param]) {
				result.addDeferredCheck(stepIndex, param, rule.RuleID)
			}
		}
	}
}

func (v *RegistryValidator) evalThresholdRule(rule registry.Rule, blueprint models.WorkflowBlueprint, result *CandidateValidationResult) {
	param := rule.Condition.Parameter
	if _, ok := numeric(rule.Condition.Value); !ok || param == "" {
		return
	}
	for stepIndex, step := range blueprint.Steps {
		tool, found := v.Tools.FindToolByName(step.Action)
		if !found || !ruleAppliesToTool(rule, tool) {
			continue
		}
		rawValue, exists := step.Parameters[param]
		if !exists {
			continue
		}
		if containsUnresolvedTemplate(rawValue) {
			result.addDeferredCheck(stepIndex, param, rule.RuleID)
			continue
		}
		violated, evaluable, reason := evaluateThresholdValue(rule, blueprint, step, rawValue)
		if !evaluable || !violated {
			continue
		}
		if rule.EnforcementAction == "require_human_approval" || rule.EnforcementAction == "block" {
			result.PolicyOK = false
			result.RiskOK = false
			result.addRuleError(rule.RuleID, reason)
		}
	}
}

func (v *RegistryValidator) evalProcessOrderRule(rule registry.Rule, stepsByAction map[string][]int, result *CandidateValidationResult) {
	actions := interfaceSliceToStrings(rule.Condition.Value)
	if len(actions) < 2 {
		return
	}
	before := strings.ToLower(actions[0])
	after := strings.ToLower(actions[1])
	beforeIndexes := stepsByAction[before]
	afterIndexes := stepsByAction[after]
	if len(afterIndexes) == 0 {
		return
	}
	if len(beforeIndexes) == 0 || minIndex(beforeIndexes) > maxIndex(afterIndexes) {
		result.ProcessOrderOK = false
		result.addRuleError(rule.RuleID, message(rule, fmt.Sprintf("%s must occur before %s", actions[0], actions[1])))
	}
}

func (v *RegistryValidator) evalSeparationOfDutiesRule(rule registry.Rule, blueprint models.WorkflowBlueprint, result *CandidateValidationResult) {
	for _, step := range blueprint.Steps {
		requester := fmt.Sprint(step.Parameters["requester_id"])
		approver := fmt.Sprint(step.Parameters["approver_id"])
		if requester != "" && requester != "<nil>" && requester == approver {
			result.PolicyOK = false
			result.addRuleError(rule.RuleID, message(rule, "requester_id and approver_id must be different"))
		}
	}
}

func (v *RegistryValidator) evalRiskRule(rule registry.Rule, blueprint models.WorkflowBlueprint, usedTools []registry.Tool, result *CandidateValidationResult) {
	requiresApproval := false
	for _, tool := range usedTools {
		if riskRank(tool.RiskLevel) >= riskRank("high") {
			requiresApproval = true
			break
		}
	}
	if requiresApproval && !hasApprovalStep(blueprint) {
		result.RiskOK = false
		result.addRuleError(rule.RuleID, message(rule, "High-risk workflow is missing approval.request_human_approval"))
	}
}

func (v *RegistryValidator) evalAuditRule(rule registry.Rule, blueprint models.WorkflowBlueprint, usedTools []registry.Tool, result *CandidateValidationResult) {
	requiresAudit := false
	for _, tool := range usedTools {
		if !tool.IsReadOnly || riskRank(tool.RiskLevel) >= riskRank("high") {
			requiresAudit = true
			break
		}
	}
	if requiresAudit && !hasAction(blueprint, "audit.write_audit_log") {
		result.PolicyOK = false
		result.addRuleError(rule.RuleID, message(rule, "Write or high-risk workflow is missing audit.write_audit_log"))
	}
}

// ResolvedPolicyViolation is an internal gate result. The runner converts it
// to ErrDispatchPolicyViolation without retaining the unredacted value.
type ResolvedPolicyViolation struct {
	StepIndex int
	ParamKey  string
	RuleID    string
	Value     interface{}
	Reason    string
}

// EvaluateResolvedStep runs the shared deterministic rule evaluators against
// values after state resolution and records the dispatch gate decision.
func (v *RegistryValidator) EvaluateResolvedStep(action string, blueprint models.WorkflowBlueprint, stepIndex int, params map[string]interface{}, token *models.ValidationToken) *ResolvedPolicyViolation {
	checkedRuleIDs := []string{}
	var violation *ResolvedPolicyViolation

	if key, value, found := firstSensitiveEntry(params, ""); found {
		violation = &ResolvedPolicyViolation{
			StepIndex: stepIndex,
			ParamKey:  key,
			RuleID:    "GLOBAL-SAFETY-002",
			Value:     value,
			Reason:    "resolved parameters contain a sensitive credential-like key",
		}
	}

	if violation == nil && token != nil {
		for _, deferred := range token.DeferredChecks {
			if deferred.StepIndex != stepIndex {
				continue
			}
			for _, ruleID := range deferred.RuleIDs {
				checkedRuleIDs = append(checkedRuleIDs, ruleID)
				rule, ok := v.enabledRuleByID(ruleID)
				if !ok {
					violation = &ResolvedPolicyViolation{
						StepIndex: stepIndex,
						ParamKey:  deferred.ParamKey,
						RuleID:    ruleID,
						Value:     params[deferred.ParamKey],
						Reason:    "deferred rule has no enabled evaluator",
					}
					break
				}
				failed, evaluable, reason := evaluateResolvedRule(rule, blueprint, blueprint.Steps[stepIndex], deferred.ParamKey, params)
				if !evaluable || failed {
					if !evaluable {
						reason = "deferred rule has no evaluator"
					}
					violation = &ResolvedPolicyViolation{
						StepIndex: stepIndex,
						ParamKey:  deferred.ParamKey,
						RuleID:    ruleID,
						Value:     params[deferred.ParamKey],
						Reason:    reason,
					}
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
		"sensitive_scan":   violation == nil || violation.RuleID != "GLOBAL-SAFETY-002",
	}
	if violation != nil {
		ruleResults["failed_rule"] = violation.RuleID
		ruleResults["param_key"] = violation.ParamKey
		ruleResults["reason"] = violation.Reason
	}
	v.auditDecision(action, "runtime", violation == nil, contentHash, registryHash, ruleResults)
	return violation
}

func evaluateResolvedRule(rule registry.Rule, blueprint models.WorkflowBlueprint, step models.WorkflowStepBlueprint, paramKey string, params map[string]interface{}) (bool, bool, string) {
	switch rule.RuleType {
	case "amount_threshold", "quantity_threshold":
		value, ok := params[paramKey]
		if !ok || containsUnresolvedTemplate(value) {
			return true, true, message(rule, fmt.Sprintf("Step %s parameter %s did not resolve to an evaluable value", step.ID, paramKey))
		}
		if _, ok := numeric(value); !ok {
			return true, true, message(rule, fmt.Sprintf("Step %s parameter %s did not resolve to a numeric value", step.ID, paramKey))
		}
		return evaluateThresholdValue(rule, blueprint, step, value)
	case "parameter_required":
		value, ok := params[paramKey]
		if !ok || isEmptyValue(value) || containsUnresolvedTemplate(value) {
			return true, true, message(rule, fmt.Sprintf("Step %s missing resolved parameter %s", step.ID, paramKey))
		}
		return false, true, ""
	case "data_confidentiality":
		if key, _, found := firstSensitiveEntry(params, ""); found {
			return true, true, message(rule, fmt.Sprintf("Step %s contains sensitive resolved parameter %s", step.ID, key))
		}
		return false, true, ""
	default:
		return false, false, ""
	}
}

func evaluateThresholdValue(rule registry.Rule, blueprint models.WorkflowBlueprint, step models.WorkflowStepBlueprint, rawValue interface{}) (bool, bool, string) {
	threshold, thresholdOK := numeric(rule.Condition.Value)
	value, valueOK := numeric(rawValue)
	if !thresholdOK || !valueOK || strings.TrimSpace(rule.Condition.Parameter) == "" || !validNumericOperator(rule.Condition.Operator) {
		return false, false, ""
	}
	if !compareNumber(value, rule.Condition.Operator, threshold) {
		return false, true, ""
	}

	switch rule.EnforcementAction {
	case "require_human_approval":
		if hasApprovalStep(blueprint) {
			return false, true, ""
		}
		return true, true, message(rule, fmt.Sprintf("Step %s has %s %.2f and requires human approval", step.ID, rule.Condition.Parameter, value))
	case "block":
		return true, true, message(rule, fmt.Sprintf("Step %s has blocked %s value %.2f", step.ID, rule.Condition.Parameter, value))
	default:
		return false, false, ""
	}
}

func validNumericOperator(operator string) bool {
	switch operator {
	case ">", ">=", "<", "<=", "==", "!=":
		return true
	default:
		return false
	}
}

func (v *RegistryValidator) enabledRuleByID(ruleID string) (registry.Rule, bool) {
	for _, rule := range v.Rules.GetEnabledRules() {
		if strings.EqualFold(strings.TrimSpace(rule.RuleID), strings.TrimSpace(ruleID)) {
			return rule, true
		}
	}
	return registry.Rule{}, false
}

func (v *RegistryValidator) deferSensitiveTemplateChecks(stepIndex int, step models.WorkflowStepBlueprint, tool registry.Tool, userRole string, result *CandidateValidationResult) {
	for paramKey, value := range step.Parameters {
		if !containsUnresolvedTemplate(value) {
			continue
		}
		for _, rule := range v.Rules.GetEnabledRules() {
			if !isSensitivityRule(rule) || !ruleAppliesToCandidate(rule, []registry.Tool{tool}, userRole, tool.RiskLevel) {
				continue
			}
			result.addDeferredCheck(stepIndex, paramKey, rule.RuleID)
		}
	}
}

func isSensitivityRule(rule registry.Rule) bool {
	return rule.RuleType == "data_confidentiality" || rule.Condition.Type == "sensitive_key"
}

func (r *CandidateValidationResult) addError(code, text string) {
	item := code + ": " + text
	if !containsString(r.Errors, item) {
		r.Errors = append(r.Errors, item)
	}
}

func (r *CandidateValidationResult) addRuleError(ruleID, text string) {
	if !containsString(r.Errors, text) {
		r.Errors = append(r.Errors, text)
	}
	if ruleID != "" && !containsString(r.FailedRules, ruleID) {
		r.FailedRules = append(r.FailedRules, ruleID)
	}
}

func (r *CandidateValidationResult) addDeferredCheck(stepIndex int, paramKey, ruleID string) {
	if strings.TrimSpace(ruleID) == "" {
		return
	}
	for index := range r.DeferredChecks {
		check := &r.DeferredChecks[index]
		if check.StepIndex != stepIndex || check.ParamKey != paramKey {
			continue
		}
		if !containsString(check.RuleIDs, ruleID) {
			check.RuleIDs = append(check.RuleIDs, ruleID)
			sort.Strings(check.RuleIDs)
		}
		return
	}
	r.DeferredChecks = append(r.DeferredChecks, models.DeferredCheck{StepIndex: stepIndex, ParamKey: paramKey, RuleIDs: []string{ruleID}})
}

func (r *CandidateValidationResult) finish() {
	r.FailedRules = uniqueStrings(r.FailedRules)
	r.Score = calculateScore(r)
	r.Passed = r.SchemaOK && r.ToolValidityOK && r.ParametersOK && r.RBACOK && r.PolicyOK && r.ProcessOrderOK && r.RiskOK && len(r.Errors) == 0
}

func calculateScore(r *CandidateValidationResult) float64 {
	score := 0.0
	if r.SchemaOK {
		score += 0.20
	}
	if r.ToolValidityOK {
		score += 0.20
	}
	if r.ParametersOK {
		score += 0.20
	}
	if r.RBACOK {
		score += 0.15
	}
	if r.PolicyOK {
		score += 0.15
	}
	if r.ProcessOrderOK {
		score += 0.05
	}
	if r.RiskOK {
		score += 0.05
	}
	return math.Round(score*100) / 100
}

func isEmptyValue(value interface{}) bool {
	if value == nil {
		return true
	}
	if text, ok := value.(string); ok {
		text = strings.TrimSpace(text)
		return text == "" || text == "<nil>" || strings.EqualFold(text, "null")
	}
	return false
}

func containsSensitiveKey(value interface{}) bool {
	_, _, found := firstSensitiveEntry(value, "")
	return found
}

func firstSensitiveEntry(value interface{}, path string) (string, interface{}, bool) {
	switch typed := value.(type) {
	case map[string]interface{}:
		for key, item := range typed {
			itemPath := key
			if path != "" {
				itemPath = path + "." + key
			}
			if isSensitiveKey(key) {
				return itemPath, item, true
			}
			if nestedKey, nestedValue, found := firstSensitiveEntry(item, itemPath); found {
				return nestedKey, nestedValue, true
			}
		}
	case []interface{}:
		for index, item := range typed {
			itemPath := fmt.Sprintf("%s[%d]", path, index)
			if nestedKey, nestedValue, found := firstSensitiveEntry(item, itemPath); found {
				return nestedKey, nestedValue, true
			}
		}
	}
	return "", nil, false
}

func containsUnresolvedTemplate(value interface{}) bool {
	switch typed := value.(type) {
	case string:
		return strings.Contains(typed, "{{") && strings.Contains(typed, "}}")
	case map[string]interface{}:
		for _, item := range typed {
			if containsUnresolvedTemplate(item) {
				return true
			}
		}
	case []interface{}:
		for _, item := range typed {
			if containsUnresolvedTemplate(item) {
				return true
			}
		}
	}
	return false
}

func isSensitiveKey(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	sensitive := []string{"password", "token", "api_key", "apikey", "secret", "authorization", "auth_header", "private_key"}
	for _, item := range sensitive {
		if strings.Contains(key, item) {
			return true
		}
	}
	return false
}

func roleIsAllowed(userRole string, allowed []string) bool {
	if len(allowed) == 0 {
		return true
	}
	role := normalizeRole(userRole)
	if role == "admin" || role == "platform_admin" {
		return true
	}
	for _, item := range allowed {
		if normalizeRole(item) == role {
			return true
		}
	}
	return false
}

func roleMatchesAny(userRole string, roles []string) bool {
	role := normalizeRole(userRole)
	for _, item := range roles {
		if normalizeRole(item) == role {
			return true
		}
	}
	return false
}

func normalizeRole(role string) string {
	role = strings.ToLower(strings.TrimSpace(role))
	role = strings.ReplaceAll(role, " ", "_")
	role = strings.ReplaceAll(role, "-", "_")
	if role == "platform_admin" {
		return "admin"
	}
	return role
}

func ruleAppliesToTool(rule registry.Rule, tool registry.Tool) bool {
	if len(rule.AppliesToTools) == 0 {
		return true
	}
	for _, item := range rule.AppliesToTools {
		if strings.EqualFold(item, tool.Name) || strings.EqualFold(item, tool.ToolID) || strings.EqualFold(item, tool.MCPToolName) {
			return true
		}
	}
	return false
}

func ruleAppliesToCandidate(rule registry.Rule, usedTools []registry.Tool, userRole, estimatedRisk string) bool {
	if len(usedTools) == 0 && !mandatoryGlobalRule(rule) {
		return false
	}

	if len(rule.AppliesToRoles) > 0 && !roleMatchesAny(userRole, rule.AppliesToRoles) {
		return false
	}

	if len(rule.AppliesToTools) > 0 {
		for _, tool := range usedTools {
			if ruleAppliesToTool(rule, tool) {
				return true
			}
		}
		return false
	}

	if strings.EqualFold(rule.Domain, "global") || strings.HasPrefix(strings.ToUpper(strings.TrimSpace(rule.RuleID)), "GLOBAL-") {
		return mandatoryGlobalRule(rule) || riskRuleApplies(rule, estimatedRisk)
	}

	if strings.TrimSpace(rule.Domain) != "" {
		return candidateUsesDomain(rule.Domain, usedTools)
	}

	return false
}

func mandatoryGlobalRule(rule registry.Rule) bool {
	switch strings.ToUpper(strings.TrimSpace(rule.RuleID)) {
	case "GLOBAL-SAFETY-001",
		"GLOBAL-SAFETY-002",
		"GLOBAL-SAFETY-003",
		"GLOBAL-AUDIT-001",
		"GLOBAL-SAFETY-008",
		"GLOBAL-SAFETY-009",
		"GLOBAL-SAFETY-010",
		"GLOBAL-SCORING-008",
		"GLOBAL-SCORING-009",
		"GLOBAL-SCORING-010":
		return true
	default:
		return false
	}
}

func riskRuleApplies(rule registry.Rule, estimatedRisk string) bool {
	if rule.RuleType != "risk_escalation" && rule.RuleType != "audit" {
		return false
	}
	value := strings.ToLower(strings.TrimSpace(fmt.Sprint(rule.Condition.Value)))
	if value == "" || value == "<nil>" {
		return riskRank(estimatedRisk) >= riskRank("high")
	}
	return riskRank(estimatedRisk) >= riskRank(value)
}

func candidateUsesDomain(domain string, usedTools []registry.Tool) bool {
	domain = strings.ToLower(strings.TrimSpace(domain))
	for _, tool := range usedTools {
		if strings.EqualFold(tool.Module, domain) || strings.EqualFold(tool.ERPSystem, domain) {
			return true
		}
		if strings.Contains(strings.ToLower(tool.ERPSystem), domain) {
			return true
		}
	}
	return false
}

func containsString(items []string, needle string) bool {
	for _, item := range items {
		if item == needle {
			return true
		}
	}
	return false
}

func interfaceSliceToStrings(value interface{}) []string {
	switch typed := value.(type) {
	case []string:
		return typed
	case []interface{}:
		out := []string{}
		for _, item := range typed {
			out = append(out, fmt.Sprint(item))
		}
		return out
	case string:
		if typed == "" {
			return nil
		}
		return []string{typed}
	default:
		return nil
	}
}

func numeric(value interface{}) (float64, bool) {
	switch typed := value.(type) {
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case jsonNumber:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case string:
		if strings.HasPrefix(typed, "{{") {
			return 0, false
		}
		var parsed float64
		_, err := fmt.Sscanf(typed, "%f", &parsed)
		return parsed, err == nil
	default:
		return 0, false
	}
}

type jsonNumber interface {
	Float64() (float64, error)
}

func compareNumber(left float64, operator string, right float64) bool {
	switch operator {
	case ">":
		return left > right
	case ">=":
		return left >= right
	case "<":
		return left < right
	case "<=":
		return left <= right
	case "==":
		return left == right
	case "!=":
		return left != right
	default:
		return false
	}
}

func hasApprovalStep(blueprint models.WorkflowBlueprint) bool {
	for _, step := range blueprint.Steps {
		action := strings.ToLower(step.Action)
		if action == "approval.request_human_approval" || strings.Contains(action, "approve") || strings.Contains(action, "approval") {
			return true
		}
	}
	return false
}

func hasAction(blueprint models.WorkflowBlueprint, action string) bool {
	for _, step := range blueprint.Steps {
		if strings.EqualFold(step.Action, action) {
			return true
		}
	}
	return false
}

func higherRisk(a, b string) string {
	if riskRank(b) > riskRank(a) {
		return strings.ToLower(b)
	}
	return strings.ToLower(a)
}

func riskRank(risk string) int {
	switch strings.ToLower(strings.TrimSpace(risk)) {
	case "critical":
		return 4
	case "high":
		return 3
	case "medium":
		return 2
	case "low":
		return 1
	default:
		return 0
	}
}

func minIndex(items []int) int {
	min := items[0]
	for _, item := range items {
		if item < min {
			min = item
		}
	}
	return min
}

func maxIndex(items []int) int {
	max := items[0]
	for _, item := range items {
		if item > max {
			max = item
		}
	}
	return max
}

func uniqueStrings(items []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, item := range items {
		if seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	sort.Strings(out)
	return out
}

func message(rule registry.Rule, fallback string) string {
	if rule.ValidatorMessage != "" {
		return rule.ValidatorMessage
	}
	return fallback
}

// ParseWorkflowYAMLStrict rejects unknown fields and multiple YAML documents.
func ParseWorkflowYAMLStrict(raw string) (models.WorkflowBlueprint, error) {
	var blueprint models.WorkflowBlueprint
	decoder := yaml.NewDecoder(strings.NewReader(parser.StripMarkdownFence(raw)))
	decoder.KnownFields(true)
	if err := decoder.Decode(&blueprint); err != nil {
		return blueprint, fmt.Errorf("parse workflow yaml: %w", err)
	}
	var extra interface{}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return blueprint, fmt.Errorf("parse workflow yaml: multiple YAML documents are not allowed")
		}
		return blueprint, fmt.Errorf("parse workflow yaml: %w", err)
	}
	return blueprint, nil
}

// WorkflowContentHash hashes the exact bytes presented to the validation gate.
func WorkflowContentHash(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func (v *RegistryValidator) RegistryHash() string {
	sum := sha256.Sum256([]byte(v.Tools.Version() + "\x00" + v.Rules.Version()))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// AuditBaselineBypass records a gate decision that Baseline B observed but
// deliberately did not enforce. It does not evaluate or alter any rule.
func (v *RegistryValidator) AuditBaselineBypass(action, actorRole, contentHash, decision, reason string, evidence map[string]interface{}) {
	timestamp := time.Now().UTC()
	actorRole = strings.TrimSpace(actorRole)
	if actorRole == "" {
		actorRole = "anonymous"
	}
	if evidence == nil {
		evidence = map[string]interface{}{}
	}
	v.Store.Mu.Lock()
	defer v.Store.Mu.Unlock()
	v.Store.Audit(
		models.Principal{ID: actorRole, Name: actorRole},
		"validation.gate.baseline_b."+action,
		models.ResourceRef{Type: "workflow_validation", ID: contentHash},
		nil,
		map[string]interface{}{
			"baseline":              "B",
			"decision":              decision,
			"reason":                reason,
			"would_have_blocked":    true,
			"evidence":              evidence,
			"registry_hash":         v.RegistryHash(),
			"workflow_content_hash": contentHash,
			"timestamp":             timestamp,
		},
		"",
		"experiment-baseline-b",
	)
}

func (v *RegistryValidator) auditDecision(action, actorRole string, passed bool, contentHash, registryHash string, ruleResults map[string]interface{}) {
	timestamp := time.Now().UTC()
	actorRole = strings.TrimSpace(actorRole)
	if actorRole == "" {
		actorRole = "anonymous"
	}
	v.Store.Mu.Lock()
	defer v.Store.Mu.Unlock()
	v.Store.Audit(
		models.Principal{ID: actorRole, Name: actorRole},
		"validation.gate."+action,
		models.ResourceRef{Type: "workflow_validation", ID: contentHash},
		nil,
		map[string]interface{}{
			"path_action":           action,
			"passed":                passed,
			"rule_results":          ruleResults,
			"registry_hash":         registryHash,
			"workflow_content_hash": contentHash,
			"timestamp":             timestamp,
		},
		"",
		"deterministic-validation-gate",
	)
}

func cloneDeferredChecks(checks []models.DeferredCheck) []models.DeferredCheck {
	out := make([]models.DeferredCheck, len(checks))
	for index, check := range checks {
		out[index] = models.DeferredCheck{
			StepIndex: check.StepIndex,
			ParamKey:  check.ParamKey,
			RuleIDs:   append([]string{}, check.RuleIDs...),
		}
	}
	return out
}

func (v *RegistryValidator) signToken(token *models.ValidationToken) string {
	payload := struct {
		WorkflowContentHash string                 `json:"workflow_content_hash"`
		RegistryHash        string                 `json:"registry_hash"`
		PassedAt            time.Time              `json:"passed_at"`
		DeferredChecks      []models.DeferredCheck `json:"deferred_checks"`
	}{
		WorkflowContentHash: token.WorkflowContentHash,
		RegistryHash:        token.RegistryHash,
		PassedAt:            token.PassedAt,
		DeferredChecks:      token.DeferredChecks,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		panic("marshal validation token proof payload: " + err.Error())
	}
	mac := hmac.New(sha256.New, v.tokenKey[:])
	_, _ = mac.Write(raw)
	return hex.EncodeToString(mac.Sum(nil))
}
