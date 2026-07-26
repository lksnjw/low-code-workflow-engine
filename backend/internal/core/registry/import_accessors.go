package registry

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

// DecodeToolStrict exposes the manager's existing strict tool decoder to the
// import pipeline without duplicating registry validation.
func DecodeToolStrict(raw []byte) (Tool, error) {
	return decodeToolStrict(raw)
}

// DecodeRuleStrict exposes the manager's existing strict rule decoder to the
// import pipeline without duplicating registry validation.
func DecodeRuleStrict(raw []byte) (Rule, error) {
	return decodeRuleStrict(raw)
}

// RegistryPaths exposes the manager's configured durable registry files.
func (m *Manager) RegistryPaths() (string, string) {
	if m == nil {
		return "", ""
	}
	return m.toolPath, m.rulePath
}

// GuardRegistryWritePath is the single write boundary protecting the frozen
// evaluation registries. It resolves absolute, relative, and existing
// symlinked forms before checking the path.
func GuardRegistryWritePath(path string) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("registry write path is required")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve registry write path %q: %w", path, err)
	}
	resolved := absolute
	if evaluated, evalErr := filepath.EvalSymlinks(absolute); evalErr == nil {
		resolved = evaluated
	} else if parent, parentErr := filepath.EvalSymlinks(filepath.Dir(absolute)); parentErr == nil {
		resolved = filepath.Join(parent, filepath.Base(absolute))
	}
	parts := strings.Split(strings.ToLower(filepath.ToSlash(filepath.Clean(resolved))), "/")
	for index := 0; index+1 < len(parts); index++ {
		if parts[index] == "configs" && parts[index+1] == "registries" {
			return fmt.Errorf("registry write rejected: %s is inside the frozen evaluation registry directory configs/registries", path)
		}
	}
	return nil
}

// RepublishRestoredBundle replaces both live snapshots while holding the same
// manager mutex used by ordinary registry mutations.
func (m *Manager) RepublishRestoredBundle(restored *Bundle) error {
	if m == nil || m.bundle == nil || m.bundle.Tools == nil || m.bundle.Rules == nil {
		return errors.New("republish restored registry: live bundle is unavailable")
	}
	if restored == nil || restored.Tools == nil || restored.Rules == nil {
		return errors.New("republish restored registry: restored bundle is unavailable")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.bundle.Tools.ReplaceAll(restored.Tools.GetAllTools(), restored.Tools.Version())
	m.bundle.Rules.ReplaceAll(restored.Rules.GetAllRules(), restored.Rules.Version())
	m.bundle.Versions.Tools = restored.Versions.Tools
	m.bundle.Versions.Rules = restored.Versions.Rules
	return nil
}

// ToolUpsertSuspension is an opaque, one-use handle. The callback remains
// private to the registry package and cannot be supplied or replaced through
// this import accessor surface.
type ToolUpsertSuspension struct {
	manager  *Manager
	callback func(Tool)
	restored bool
}

// SuspendToolUpsertCallback pauses callback side effects during a multi-record
// import without exposing the callback function to the caller.
func (m *Manager) SuspendToolUpsertCallback() *ToolUpsertSuspension {
	if m == nil {
		return &ToolUpsertSuspension{restored: true}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	suspension := &ToolUpsertSuspension{manager: m, callback: m.onToolUpsert}
	m.onToolUpsert = nil
	return suspension
}

// Restore restores the captured callback without accepting a replacement.
func (s *ToolUpsertSuspension) Restore() {
	s.restoreAndNotify(nil)
}

// RestoreAndNotify restores the captured callback, then invokes it for tools
// durably published by the completed import.
func (s *ToolUpsertSuspension) RestoreAndNotify(tools []Tool) {
	s.restoreAndNotify(tools)
}

func (s *ToolUpsertSuspension) restoreAndNotify(tools []Tool) {
	if s == nil || s.manager == nil {
		return
	}
	s.manager.mu.Lock()
	if s.restored {
		s.manager.mu.Unlock()
		return
	}
	s.manager.onToolUpsert = s.callback
	s.restored = true
	callback := s.callback
	s.manager.mu.Unlock()
	if callback != nil {
		for _, tool := range tools {
			callback(tool)
		}
	}
}
