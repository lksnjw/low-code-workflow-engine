package registry

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// BulkImportError identifies an entry rejected before a batch mutation starts.
type BulkImportError struct {
	Index  int    `json:"index"`
	ID     string `json:"id,omitempty"`
	Reason string `json:"reason"`
}

// BulkMutationResult describes one all-or-nothing registry publication.
type BulkMutationResult[T any] struct {
	Items                    []T      `json:"items"`
	Count                    int      `json:"count"`
	IDs                      []string `json:"ids"`
	OldHash                  string   `json:"oldHash"`
	NewHash                  string   `json:"newHash"`
	SemanticRebuildSuggested bool     `json:"semanticRebuildSuggested"`
}

// ImportTools strictly decodes every tool using the same decoder as AddTool
// before it persists or publishes any entry. Existing IDs are updates only
// when allowUpdates was explicitly set on the request.
func (m *Manager) ImportTools(raw []byte, allowUpdates bool) (BulkMutationResult[Tool], []BulkImportError, error) {
	items, err := decodeBatch(raw)
	if err != nil {
		return BulkMutationResult[Tool]{}, nil, err
	}
	decoded := make([]Tool, len(items))
	validationErrors := make([]BulkImportError, 0)
	seenIDs := make(map[string]int, len(items))
	seenNames := make(map[string]int, len(items))
	for index, item := range items {
		tool, decodeErr := decodeToolStrict(item)
		if decodeErr != nil {
			validationErrors = append(validationErrors, BulkImportError{Index: index, ID: batchIdentifier(item, "tool_id"), Reason: decodeErr.Error()})
			continue
		}
		decoded[index] = tool
		idKey := normalImportKey(tool.ToolID)
		if first, duplicate := seenIDs[idKey]; duplicate {
			validationErrors = append(validationErrors, BulkImportError{Index: index, ID: tool.ToolID, Reason: fmt.Sprintf("tool id is duplicated in the batch (first appears at index %d)", first)})
		} else {
			seenIDs[idKey] = index
		}
		nameKey := normalImportKey(tool.Name)
		if first, duplicate := seenNames[nameKey]; duplicate {
			validationErrors = append(validationErrors, BulkImportError{Index: index, ID: tool.ToolID, Reason: fmt.Sprintf("tool name is duplicated in the batch (first appears at index %d)", first)})
		} else {
			seenNames[nameKey] = index
		}
	}
	if len(validationErrors) > 0 {
		return BulkMutationResult[Tool]{}, validationErrors, nil
	}
	if err := m.validatePaths(); err != nil {
		return BulkMutationResult[Tool]{}, nil, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	existing := m.bundle.Tools.GetAllTools()
	byID := make(map[string]int, len(existing))
	byName := make(map[string]Tool, len(existing))
	for index, tool := range existing {
		byID[normalImportKey(tool.ToolID)] = index
		byName[normalImportKey(tool.Name)] = tool
	}
	for index, tool := range decoded {
		idKey := normalImportKey(tool.ToolID)
		if _, collision := byID[idKey]; collision && !allowUpdates {
			validationErrors = append(validationErrors, BulkImportError{Index: index, ID: tool.ToolID, Reason: "tool id already exists; mark the request with allowUpdates=true to update it"})
		}
		if named, collision := byName[normalImportKey(tool.Name)]; collision && !strings.EqualFold(named.ToolID, tool.ToolID) {
			validationErrors = append(validationErrors, BulkImportError{Index: index, ID: tool.ToolID, Reason: fmt.Sprintf("tool name %q already exists on tool %q", tool.Name, named.ToolID)})
		}
	}
	if len(validationErrors) > 0 {
		return BulkMutationResult[Tool]{}, validationErrors, nil
	}

	prospective := append([]Tool{}, existing...)
	ids := make([]string, 0, len(decoded))
	for _, tool := range decoded {
		if index, update := byID[normalImportKey(tool.ToolID)]; update {
			prospective[index] = tool
		} else {
			byID[normalImportKey(tool.ToolID)] = len(prospective)
			prospective = append(prospective, tool)
		}
		ids = append(ids, tool.ToolID)
	}
	oldHash := combinedHash(m.bundle.Tools.Version(), m.bundle.Rules.Version())
	version, err := m.persistToolsLocked(prospective)
	if err != nil {
		return BulkMutationResult[Tool]{}, nil, err
	}
	m.publishToolsLocked(prospective, version, decoded)
	return BulkMutationResult[Tool]{
		Items: decoded, Count: len(decoded), IDs: ids, OldHash: oldHash,
		NewHash: combinedHash(version, m.bundle.Rules.Version()), SemanticRebuildSuggested: true,
	}, nil, nil
}

// ImportRules strictly decodes every rule using the same decoder as AddRule
// before it persists or publishes any entry.
func (m *Manager) ImportRules(raw []byte, allowUpdates bool) (BulkMutationResult[Rule], []BulkImportError, error) {
	items, err := decodeBatch(raw)
	if err != nil {
		return BulkMutationResult[Rule]{}, nil, err
	}
	decoded := make([]Rule, len(items))
	validationErrors := make([]BulkImportError, 0)
	seenIDs := make(map[string]int, len(items))
	for index, item := range items {
		rule, decodeErr := decodeRuleStrict(item)
		if decodeErr != nil {
			validationErrors = append(validationErrors, BulkImportError{Index: index, ID: batchIdentifier(item, "rule_id"), Reason: decodeErr.Error()})
			continue
		}
		decoded[index] = rule
		idKey := normalImportKey(rule.RuleID)
		if first, duplicate := seenIDs[idKey]; duplicate {
			validationErrors = append(validationErrors, BulkImportError{Index: index, ID: rule.RuleID, Reason: fmt.Sprintf("rule id is duplicated in the batch (first appears at index %d)", first)})
		} else {
			seenIDs[idKey] = index
		}
	}
	if len(validationErrors) > 0 {
		return BulkMutationResult[Rule]{}, validationErrors, nil
	}
	if err := m.validatePaths(); err != nil {
		return BulkMutationResult[Rule]{}, nil, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	existing := m.bundle.Rules.GetAllRules()
	byID := make(map[string]int, len(existing))
	for index, rule := range existing {
		byID[normalImportKey(rule.RuleID)] = index
	}
	for index, rule := range decoded {
		if _, collision := byID[normalImportKey(rule.RuleID)]; collision && !allowUpdates {
			validationErrors = append(validationErrors, BulkImportError{Index: index, ID: rule.RuleID, Reason: "rule id already exists; mark the request with allowUpdates=true to update it"})
		}
	}
	if len(validationErrors) > 0 {
		return BulkMutationResult[Rule]{}, validationErrors, nil
	}

	prospective := append([]Rule{}, existing...)
	ids := make([]string, 0, len(decoded))
	for _, rule := range decoded {
		if index, update := byID[normalImportKey(rule.RuleID)]; update {
			prospective[index] = rule
		} else {
			byID[normalImportKey(rule.RuleID)] = len(prospective)
			prospective = append(prospective, rule)
		}
		ids = append(ids, rule.RuleID)
	}
	oldHash := combinedHash(m.bundle.Tools.Version(), m.bundle.Rules.Version())
	version, err := m.persistRulesLocked(prospective)
	if err != nil {
		return BulkMutationResult[Rule]{}, nil, err
	}
	m.publishRulesLocked(prospective, version)
	return BulkMutationResult[Rule]{
		Items: decoded, Count: len(decoded), IDs: ids, OldHash: oldHash,
		NewHash: combinedHash(m.bundle.Tools.Version(), version), SemanticRebuildSuggested: true,
	}, nil, nil
}

func decodeBatch(raw []byte) ([]json.RawMessage, error) {
	var items []json.RawMessage
	if err := decodeStrict(raw, &items); err != nil {
		return nil, fmt.Errorf("invalid registry import: expected one JSON array: %w", err)
	}
	if len(items) == 0 {
		return nil, errors.New("invalid registry import: at least one entry is required")
	}
	return items, nil
}

func batchIdentifier(raw []byte, field string) string {
	var value map[string]interface{}
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	id, _ := value[field].(string)
	return id
}

func normalImportKey(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}
