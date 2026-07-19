package runner

import (
	"regexp"
	"strings"

	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/pkg/parser"
)

var exactVariablePattern = regexp.MustCompile(`^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$`)

type StateManager struct {
	state models.RunnerState
}

func NewStateManager(state models.RunnerState) *StateManager {
	if state.Variables == nil {
		state.Variables = map[string]interface{}{}
	}
	return &StateManager{state: state}
}

func (m *StateManager) Resolve(params map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(params))
	for key, value := range params {
		out[key] = resolveValue(value, m.state.Variables)
	}
	return out
}

func resolveValue(value interface{}, state map[string]interface{}) interface{} {
	switch typed := value.(type) {
	case string:
		matches := exactVariablePattern.FindStringSubmatch(strings.TrimSpace(typed))
		if len(matches) == 2 {
			if resolved, ok := lookupStatePath(state, matches[1]); ok {
				return resolved
			}
		}
		return parser.ResolveVariables(typed, state)
	case []interface{}:
		out := make([]interface{}, len(typed))
		for index, item := range typed {
			out[index] = resolveValue(item, state)
		}
		return out
	case map[string]interface{}:
		out := make(map[string]interface{}, len(typed))
		for key, item := range typed {
			out[key] = resolveValue(item, state)
		}
		return out
	default:
		return value
	}
}

func lookupStatePath(state map[string]interface{}, path string) (interface{}, bool) {
	parts := strings.Split(path, ".")
	var current interface{} = state
	for _, part := range parts {
		asMap, ok := current.(map[string]interface{})
		if !ok {
			return nil, false
		}
		current, ok = asMap[part]
		if !ok {
			return nil, false
		}
	}
	return current, true
}

func (m *StateManager) Save(stepID string, result map[string]interface{}) {
	m.state.Variables[stepID] = result
}

func (m *StateManager) Snapshot() map[string]interface{} {
	return m.state.Variables
}
