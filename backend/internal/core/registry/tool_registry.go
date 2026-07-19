package registry

import (
	"strings"
	"sync"
)

type ToolRegistry struct {
	mu      sync.RWMutex
	tools   []Tool
	byName  map[string]Tool
	byID    map[string]Tool
	version string
}

func NewToolRegistry(tools []Tool, version string) *ToolRegistry {
	reg := &ToolRegistry{tools: []Tool{}, byName: map[string]Tool{}, byID: map[string]Tool{}, version: version}
	for _, tool := range tools {
		reg.Add(tool)
	}
	return reg
}

func (r *ToolRegistry) Add(tool Tool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	regName := normalizeName(tool.Name)
	r.tools = append(r.tools, tool)
	r.byName[regName] = tool
	if tool.ToolID != "" {
		r.byID[normalizeName(tool.ToolID)] = tool
	}
	if tool.MCPToolName != "" {
		r.byName[normalizeName(tool.MCPToolName)] = tool
	}
}

// ReplaceAll atomically publishes a complete validated tool snapshot.
func (r *ToolRegistry) ReplaceAll(tools []Tool, version string) {
	byName := make(map[string]Tool, len(tools)*2)
	byID := make(map[string]Tool, len(tools))
	snapshot := append([]Tool(nil), tools...)
	for _, tool := range snapshot {
		byName[normalizeName(tool.Name)] = tool
		if tool.ToolID != "" {
			byID[normalizeName(tool.ToolID)] = tool
		}
		if tool.MCPToolName != "" {
			byName[normalizeName(tool.MCPToolName)] = tool
		}
	}

	r.mu.Lock()
	r.tools = snapshot
	r.byName = byName
	r.byID = byID
	r.version = version
	r.mu.Unlock()
}

func (r *ToolRegistry) GetAllTools() []Tool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Tool, len(r.tools))
	copy(out, r.tools)
	return out
}

func (r *ToolRegistry) FindToolByName(name string) (Tool, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	tool, ok := r.byName[normalizeName(name)]
	return tool, ok
}

func (r *ToolRegistry) FindToolByID(id string) (Tool, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	tool, ok := r.byID[normalizeName(id)]
	return tool, ok
}

func (r *ToolRegistry) IsToolExecutable(name string) bool {
	tool, ok := r.FindToolByName(name)
	if !ok {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(tool.Status), "active_mcp_schema_present")
}

func (r *ToolRegistry) IsCapabilityGap(name string) bool {
	tool, ok := r.FindToolByName(name)
	if !ok {
		return true
	}
	status := strings.ToLower(strings.TrimSpace(tool.Status))
	return status == "recommended_future_capability" || status == "mock_endpoint_available_schema_missing"
}

func (r *ToolRegistry) Version() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.version
}

func normalizeName(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}
