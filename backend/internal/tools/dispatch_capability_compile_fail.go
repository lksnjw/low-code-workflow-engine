//go:build ignore

// This file documents the compile-time boundary. Running
// `go test` after removing the build tag fails because code outside the
// validator package cannot name or populate DispatchCapability.proof.
package tools

import workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"

var impossibleCapability = workflowvalidator.DispatchCapability{
	proof: workflowvalidator.dispatchProof{minted: true},
}
