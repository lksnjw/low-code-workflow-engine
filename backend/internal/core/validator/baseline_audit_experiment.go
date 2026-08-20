//go:build experiment

package validator

import (
	"strings"
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

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
