//go:build !experiment

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
}

func (e *Executor) handleValidationTokenBlock(_ string, _ string, _ string, reason string, _ map[string]interface{}) error {
	return fmt.Errorf("%s", reason)
}

func (e *Executor) handleDispatchViolation(_ string, _ string, violation *workflowvalidator.ResolvedPolicyViolation) *ErrDispatchPolicyViolation {
	return &ErrDispatchPolicyViolation{
		StepIndex:     violation.StepIndex,
		ParamKey:      violation.ParamKey,
		RuleID:        violation.RuleID,
		RedactedValue: redactValue(violation.Value),
	}
}
