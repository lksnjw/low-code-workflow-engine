//go:build experiment

package runner

import (
	"fmt"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/analysisprovider"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
	"go.uber.org/zap"
)

type Executor struct {
	Registry         *tools.Registry
	Validator        *workflowvalidator.RegistryValidator
	AnalysisProvider analysisprovider.Provider
	Log              *zap.Logger
	baselineB        bool
}

// SetBaselineB is compiled only for experiment builds. Enabling gate-off mode
// fails unless every registered tool is an explicitly marked spy or no-op.
func (e *Executor) SetBaselineB(enabled bool) error {
	if enabled {
		if err := e.Registry.RequireExperimentSafeTools(); err != nil {
			return err
		}
	}
	e.baselineB = enabled
	return nil
}

func (e *Executor) BaselineBEnabled() bool {
	return e.baselineB
}

func (e *Executor) handleValidationTokenBlock(executionID, contentHash, decision, reason string, evidence map[string]interface{}) error {
	if !e.baselineB {
		return fmt.Errorf("%s", reason)
	}
	e.Validator.AuditBaselineBypass("entry."+executionID, "runtime", contentHash, decision, reason, evidence)
	if e.Log != nil {
		e.Log.Warn("Baseline B bypassed validation-token gate", zap.String("baseline", "B"), zap.String("decision", decision), zap.String("execution_id", executionID))
	}
	return nil
}

func (e *Executor) handleDispatchViolation(executionID, contentHash string, violation *workflowvalidator.ResolvedPolicyViolation) *ErrDispatchPolicyViolation {
	if !e.baselineB {
		return &ErrDispatchPolicyViolation{
			StepIndex:     violation.StepIndex,
			ParamKey:      violation.ParamKey,
			RuleID:        violation.RuleID,
			RedactedValue: redactValue(violation.Value),
		}
	}
	e.Validator.AuditBaselineBypass("dispatch."+executionID, "runtime", contentHash, "dispatch_revalidation", violation.Reason, map[string]interface{}{
		"step_index": violation.StepIndex,
		"param_key":  violation.ParamKey,
		"rule_id":    violation.RuleID,
	})
	if e.Log != nil {
		e.Log.Warn("Baseline B bypassed dispatch gate", zap.String("baseline", "B"), zap.String("rule_id", violation.RuleID), zap.Int("step_index", violation.StepIndex), zap.String("execution_id", executionID))
	}
	return nil
}
