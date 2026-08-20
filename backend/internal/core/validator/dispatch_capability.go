package validator

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

// dispatchProof is deliberately unexported. Code outside this package cannot
// construct the proof field required by a usable DispatchCapability.
type dispatchProof struct {
	minted bool
}

// DispatchCapability binds one successful dispatch-time evaluation to the
// exact resolved parameters and registry/workflow snapshot that were checked.
type DispatchCapability struct {
	proof                 dispatchProof
	workflowContentHash   string
	registryHash          string
	stepIndex             int
	action                string
	resolvedParameterHash string
}

func (c DispatchCapability) IsUsable() bool {
	return c.proof.minted &&
		strings.TrimSpace(c.workflowContentHash) != "" &&
		strings.TrimSpace(c.registryHash) != "" &&
		c.stepIndex >= 0 &&
		strings.TrimSpace(c.action) != "" &&
		strings.TrimSpace(c.resolvedParameterHash) != ""
}

func (c DispatchCapability) WorkflowContentHash() string { return c.workflowContentHash }
func (c DispatchCapability) RegistryHash() string        { return c.registryHash }
func (c DispatchCapability) StepIndex() int              { return c.stepIndex }
func (c DispatchCapability) Action() string              { return c.action }
func (c DispatchCapability) ResolvedParameterHash() string {
	return c.resolvedParameterHash
}

// ResolvedParameterHash computes the canonical hash checked immediately before
// an MCP request is sent. encoding/json orders string-keyed map entries.
func ResolvedParameterHash(params map[string]interface{}) (string, error) {
	raw, err := json.Marshal(params)
	if err != nil {
		return "", fmt.Errorf("encode resolved parameters for dispatch hash: %w", err)
	}
	return ResolvedParameterHashBytes(raw), nil
}

// ResolvedParameterHashBytes hashes an already serialized parameter payload.
// MCP uses this so the compared bytes are exactly the bytes placed on the wire.
func ResolvedParameterHashBytes(raw []byte) string {
	sum := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func (v *RegistryValidator) mintDispatchCapability(token *models.ValidationToken, blueprint models.WorkflowBlueprint, stepIndex int, params map[string]interface{}) (DispatchCapability, error) {
	if token == nil || !v.VerifyToken(token) {
		return DispatchCapability{}, fmt.Errorf("validated token proof is required to mint a dispatch capability")
	}
	if token.RegistryHash != v.RegistryHash() {
		return DispatchCapability{}, fmt.Errorf("validated token registry hash does not match the active registry")
	}
	if stepIndex < 0 || stepIndex >= len(blueprint.Steps) {
		return DispatchCapability{}, fmt.Errorf("dispatch step index %d is outside the validated workflow", stepIndex)
	}
	parameterHash, err := ResolvedParameterHash(params)
	if err != nil {
		return DispatchCapability{}, err
	}
	return DispatchCapability{
		proof:                 dispatchProof{minted: true},
		workflowContentHash:   token.WorkflowContentHash,
		registryHash:          token.RegistryHash,
		stepIndex:             stepIndex,
		action:                blueprint.Steps[stepIndex].Action,
		resolvedParameterHash: parameterHash,
	}, nil
}
