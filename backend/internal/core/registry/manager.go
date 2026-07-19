package registry

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type MutationResult[T any] struct {
	Item                     T      `json:"item"`
	OldHash                  string `json:"oldHash"`
	NewHash                  string `json:"newHash"`
	SemanticRebuildSuggested bool   `json:"semanticRebuildSuggested"`
}

type Manager struct {
	mu           sync.Mutex
	bundle       *Bundle
	toolPath     string
	rulePath     string
	onToolUpsert func(Tool)
}

func NewManager(bundle *Bundle, toolPath, rulePath string) *Manager {
	return &Manager{bundle: bundle, toolPath: toolPath, rulePath: rulePath}
}

func (m *Manager) SetToolUpsert(callback func(Tool)) {
	m.mu.Lock()
	m.onToolUpsert = callback
	m.mu.Unlock()
}

func (m *Manager) Hash() string {
	if m == nil || m.bundle == nil || m.bundle.Tools == nil || m.bundle.Rules == nil {
		return ""
	}
	return combinedHash(m.bundle.Tools.Version(), m.bundle.Rules.Version())
}

func (m *Manager) Tools() []Tool {
	if m == nil || m.bundle == nil || m.bundle.Tools == nil {
		return []Tool{}
	}
	return m.bundle.Tools.GetAllTools()
}

func (m *Manager) Rules() []Rule {
	if m == nil || m.bundle == nil || m.bundle.Rules == nil {
		return []Rule{}
	}
	return m.bundle.Rules.GetAllRules()
}

func (m *Manager) AddTool(raw []byte) (MutationResult[Tool], error) {
	tool, err := decodeToolStrict(raw)
	if err != nil {
		return MutationResult[Tool]{}, err
	}
	return m.mutateTool(tool, "", false)
}

func (m *Manager) UpdateTool(id string, raw []byte) (MutationResult[Tool], error) {
	tool, err := decodeToolStrict(raw)
	if err != nil {
		return MutationResult[Tool]{}, err
	}
	return m.mutateTool(tool, id, true)
}

func (m *Manager) AddRule(raw []byte) (MutationResult[Rule], error) {
	rule, err := decodeRuleStrict(raw)
	if err != nil {
		return MutationResult[Rule]{}, err
	}
	return m.mutateRule(rule, "", false)
}

func (m *Manager) UpdateRule(id string, raw []byte) (MutationResult[Rule], error) {
	rule, err := decodeRuleStrict(raw)
	if err != nil {
		return MutationResult[Rule]{}, err
	}
	return m.mutateRule(rule, id, true)
}

func (m *Manager) mutateTool(tool Tool, pathID string, update bool) (MutationResult[Tool], error) {
	if m == nil || m.bundle == nil || m.bundle.Tools == nil || m.bundle.Rules == nil {
		return MutationResult[Tool]{}, errors.New("registry manager is not configured")
	}
	if strings.TrimSpace(m.toolPath) == "" {
		return MutationResult[Tool]{}, errors.New("tool registry file path is not configured")
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	tools := m.bundle.Tools.GetAllTools()
	index := -1
	for i, existing := range tools {
		if strings.EqualFold(existing.ToolID, tool.ToolID) {
			index = i
		}
		if strings.EqualFold(existing.Name, tool.Name) && !strings.EqualFold(existing.ToolID, tool.ToolID) {
			return MutationResult[Tool]{}, fmt.Errorf("tool name %q already exists", tool.Name)
		}
	}
	if update {
		if !strings.EqualFold(strings.TrimSpace(pathID), tool.ToolID) {
			return MutationResult[Tool]{}, errors.New("path id must match tool_id")
		}
		if index < 0 {
			return MutationResult[Tool]{}, fmt.Errorf("tool %q was not found", pathID)
		}
		tools[index] = tool
	} else {
		if index >= 0 {
			return MutationResult[Tool]{}, fmt.Errorf("tool id %q already exists", tool.ToolID)
		}
		tools = append(tools, tool)
	}

	oldHash := combinedHash(m.bundle.Tools.Version(), m.bundle.Rules.Version())
	raw, err := persistRegistryJSON(m.toolPath, tools)
	if err != nil {
		return MutationResult[Tool]{}, err
	}
	version := checksum(raw)
	m.bundle.Tools.ReplaceAll(tools, version)
	m.bundle.Versions.Tools = version
	if m.onToolUpsert != nil {
		m.onToolUpsert(tool)
	}
	return MutationResult[Tool]{Item: tool, OldHash: oldHash, NewHash: combinedHash(version, m.bundle.Rules.Version()), SemanticRebuildSuggested: true}, nil
}

func (m *Manager) mutateRule(rule Rule, pathID string, update bool) (MutationResult[Rule], error) {
	if m == nil || m.bundle == nil || m.bundle.Tools == nil || m.bundle.Rules == nil {
		return MutationResult[Rule]{}, errors.New("registry manager is not configured")
	}
	if strings.TrimSpace(m.rulePath) == "" {
		return MutationResult[Rule]{}, errors.New("rule registry file path is not configured")
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	rules := m.bundle.Rules.GetAllRules()
	index := -1
	for i, existing := range rules {
		if strings.EqualFold(existing.RuleID, rule.RuleID) {
			index = i
			break
		}
	}
	if update {
		if !strings.EqualFold(strings.TrimSpace(pathID), rule.RuleID) {
			return MutationResult[Rule]{}, errors.New("path id must match rule_id")
		}
		if index < 0 {
			return MutationResult[Rule]{}, fmt.Errorf("rule %q was not found", pathID)
		}
		rules[index] = rule
	} else {
		if index >= 0 {
			return MutationResult[Rule]{}, fmt.Errorf("rule id %q already exists", rule.RuleID)
		}
		rules = append(rules, rule)
	}

	oldHash := combinedHash(m.bundle.Tools.Version(), m.bundle.Rules.Version())
	raw, err := persistRegistryJSON(m.rulePath, rules)
	if err != nil {
		return MutationResult[Rule]{}, err
	}
	version := checksum(raw)
	m.bundle.Rules.ReplaceAll(rules, version)
	m.bundle.Versions.Rules = version
	return MutationResult[Rule]{Item: rule, OldHash: oldHash, NewHash: combinedHash(m.bundle.Tools.Version(), version), SemanticRebuildSuggested: true}, nil
}

func decodeToolStrict(raw []byte) (Tool, error) {
	var tool Tool
	if err := decodeStrict(raw, &tool); err != nil {
		return Tool{}, fmt.Errorf("invalid tool schema: %w", err)
	}
	tool.SourceFile = ""
	if missing := requiredStrings(map[string]string{
		"tool_id": tool.ToolID, "name": tool.Name, "display_name": tool.DisplayName,
		"module": tool.Module, "status": tool.Status, "description": tool.Description,
		"http_method": tool.HTTPMethod, "mcp_tool_name": tool.MCPToolName,
	}); len(missing) > 0 {
		return Tool{}, fmt.Errorf("invalid tool schema: required fields missing: %s", strings.Join(missing, ", "))
	}
	if tool.InputSchema == nil {
		return Tool{}, errors.New("invalid tool schema: input_schema is required")
	}
	return tool, nil
}

func decodeRuleStrict(raw []byte) (Rule, error) {
	var rule Rule
	if err := decodeStrict(raw, &rule); err != nil {
		return Rule{}, fmt.Errorf("invalid rule: %w", err)
	}
	rule.SourceFile = ""
	if missing := requiredStrings(map[string]string{
		"rule_id": rule.RuleID, "rule_name": rule.RuleName, "rule_type": rule.RuleType,
		"domain": rule.Domain, "description": rule.Description, "enforcement_action": rule.EnforcementAction,
		"severity": rule.Severity, "validator_message": rule.ValidatorMessage,
		"condition.type": rule.Condition.Type, "condition.operator": rule.Condition.Operator,
	}); len(missing) > 0 {
		return Rule{}, fmt.Errorf("invalid rule: required fields missing: %s", strings.Join(missing, ", "))
	}
	return rule, nil
}

func decodeStrict(raw []byte, target interface{}) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("request must contain exactly one JSON object")
		}
		return err
	}
	return nil
}

func requiredStrings(fields map[string]string) []string {
	missing := []string{}
	for name, value := range fields {
		if strings.TrimSpace(value) == "" {
			missing = append(missing, name)
		}
	}
	return missing
}

func persistRegistryJSON(path string, value interface{}) ([]byte, error) {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode registry: %w", err)
	}
	raw = append(raw, '\n')
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return nil, fmt.Errorf("create registry temp file: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if _, err := temp.Write(raw); err != nil {
		temp.Close()
		return nil, fmt.Errorf("write registry temp file: %w", err)
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return nil, fmt.Errorf("sync registry temp file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return nil, fmt.Errorf("close registry temp file: %w", err)
	}
	if err := replaceFile(tempPath, path); err != nil {
		return nil, err
	}
	return raw, nil
}

func replaceFile(tempPath, targetPath string) error {
	if err := os.Rename(tempPath, targetPath); err == nil {
		return nil
	}
	backupPath := targetPath + ".backup"
	_ = os.Remove(backupPath)
	if err := os.Rename(targetPath, backupPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("prepare registry replacement: %w", err)
	}
	if err := os.Rename(tempPath, targetPath); err != nil {
		_ = os.Rename(backupPath, targetPath)
		return fmt.Errorf("replace registry file: %w", err)
	}
	_ = os.Remove(backupPath)
	return nil
}

func combinedHash(toolVersion, ruleVersion string) string {
	sum := sha256.Sum256([]byte(toolVersion + "\x00" + ruleVersion))
	return "sha256:" + hex.EncodeToString(sum[:])
}
