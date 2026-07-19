package models

import "time"

// ValidationToken binds a successful full-gate decision to the exact workflow
// content and registry versions used for that decision.
type ValidationToken struct {
	WorkflowContentHash string          `json:"workflow_content_hash"`
	RegistryHash        string          `json:"registry_hash"`
	PassedAt            time.Time       `json:"passed_at"`
	DeferredChecks      []DeferredCheck `json:"deferred_checks"`
	Proof               string          `json:"-"`
}

// DeferredCheck identifies a policy rule that must be evaluated after a
// template parameter has been resolved by the runner.
type DeferredCheck struct {
	StepIndex int      `json:"step_index"`
	ParamKey  string   `json:"param_key"`
	RuleIDs   []string `json:"rule_ids"`
}
