//go:build experiment

package tools

import "fmt"

// ExperimentSafeTool marks a spy or no-op implementation that cannot perform
// an external dispatch. Real MCP-backed tools intentionally do not implement it.
type ExperimentSafeTool interface {
	Tool
	ExperimentNoExternalDispatch()
}

// RequireExperimentSafeTools refuses gate-off mode when any reachable tool can
// perform a real external call.
func (r *Registry) RequireExperimentSafeTools() error {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.fallback != nil {
		if _, ok := r.fallback.(ExperimentSafeTool); !ok {
			return fmt.Errorf("experiment gate-off registry fallback %q is not a spy/no-op tool", r.fallback.Name())
		}
	}
	for name, tool := range r.tools {
		if _, ok := tool.(ExperimentSafeTool); !ok {
			return fmt.Errorf("experiment gate-off registry tool %q is not a spy/no-op tool", name)
		}
	}
	return nil
}
