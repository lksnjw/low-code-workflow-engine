package importer

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	generationcontext "github.com/sanjeewa/agentic-orchestrator/internal/core/context"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"go.uber.org/zap"
)

const MaxUploadBytes = 10 * 1024 * 1024

type Service struct {
	mu       sync.Mutex
	manager  *registry.Manager
	log      *zap.Logger
	context  *generationcontext.Service
	analyses map[string]*Analysis
	history  []HistoryEntry
}

func NewService(manager *registry.Manager, log *zap.Logger) *Service {
	return NewServiceWithContext(manager, generationcontext.NewService(manager, log), log)
}

func NewServiceWithContext(manager *registry.Manager, contextService *generationcontext.Service, log *zap.Logger) *Service {
	if log == nil {
		log = zap.NewNop()
	}
	return &Service{manager: manager, log: log, context: contextService, analyses: map[string]*Analysis{}, history: []HistoryEntry{}}
}

func (s *Service) Analyse(input AnalyseInput) (Analysis, error) {
	if s == nil || s.manager == nil {
		return Analysis{}, errors.New("registry import service is not configured")
	}
	if len(input.Content) > MaxUploadBytes {
		return Analysis{}, fmt.Errorf("uploaded file exceeds the %d MiB limit", MaxUploadBytes/(1024*1024))
	}
	if input.Kind != SourceTools && input.Kind != SourceRules && input.Kind != SourceOpenAPI {
		return Analysis{}, fmt.Errorf("source kind must be %q, %q, or %q", SourceTools, SourceRules, SourceOpenAPI)
	}
	now := time.Now().UTC()
	sum := sha256.Sum256(input.Content)
	analysis := Analysis{
		ID: randomAnalysisID(), Filename: filepath.Base(input.Filename), FileSHA256: "sha256:" + hex.EncodeToString(sum[:]),
		Kind: input.Kind, AllowUpdates: input.AllowUpdates, Preview: emptyPreview(), CreatedAt: now,
		Stages: []StageResult{
			{Name: StageParse, Status: "complete"},
			{Name: StageNormalise, Status: "complete"},
			{Name: StageValidate, Status: "complete"},
			{Name: StageDiff, Status: "complete"},
			{Name: StageConfirm, Status: "awaiting_human_confirmation"},
			{Name: StageCommit, Status: "pending"},
		},
	}

	var records []ImportRecord
	if input.Kind == SourceOpenAPI {
		openAPIRecords, err := normaliseOpenAPI(input.Filename, input.Content, input.Prefix)
		if err != nil {
			analysis.Preview.Rejected = append(analysis.Preview.Rejected, fileRejection(input.Kind, err))
			analysis.Stages[0].Status = "failed"
			analysis.Stages[1].Status = "blocked"
			analysis.Stages[2].Status = "blocked"
			analysis.Stages[3].Status = "blocked"
		} else {
			records = openAPIRecords
		}
	} else {
		sourceRecords, err := parseRegistryRecords(input.Filename, input.Content)
		if err != nil {
			analysis.Preview.Rejected = append(analysis.Preview.Rejected, fileRejection(input.Kind, err))
			analysis.Stages[0].Status = "failed"
			analysis.Stages[1].Status = "blocked"
			analysis.Stages[2].Status = "blocked"
			analysis.Stages[3].Status = "blocked"
		} else {
			records = normaliseRegistryRecords(input.Kind, sourceRecords)
		}
	}
	if len(records) > 0 {
		analysis.Preview = s.validateAndDiff(input, records)
	}

	s.mu.Lock()
	s.analyses[analysis.ID] = cloneAnalysisPointer(&analysis)
	s.mu.Unlock()
	return *cloneAnalysisPointer(&analysis), nil
}

func normaliseRegistryRecords(kind SourceKind, records []sourceRecord) []ImportRecord {
	out := make([]ImportRecord, 0, len(records))
	for _, source := range records {
		record := ImportRecord{
			RegistryKind: kind, Line: source.Line, Index: source.Index, Category: "",
			Changes: []FieldChange{}, Errors: []RecordError{}, Metadata: map[string]interface{}{},
		}
		if kind == SourceTools {
			record.SourceID = sourceIdentifier(source.Raw, "tool_id")
			record.RecordID = recordIdentifier("tool", record.SourceID, source.Index)
			if len(source.Errors) > 0 {
				record.Category = "Rejected"
				record.Errors = sourceErrorsForRecord(source.Errors, record.SourceID)
			} else if tool, err := registry.DecodeToolStrict(source.Raw); err != nil {
				record.Category = "Rejected"
				record.Errors = strictRecordErrors(record.SourceID, source.Line, source.Index, err)
			} else {
				record.SourceID = tool.ToolID
				record.RecordID = "tool:" + tool.ToolID
				record.Tool = &tool
			}
		} else {
			record.SourceID = sourceIdentifier(source.Raw, "rule_id")
			record.RecordID = recordIdentifier("rule", record.SourceID, source.Index)
			if len(source.Errors) > 0 {
				record.Category = "Rejected"
				record.Errors = sourceErrorsForRecord(source.Errors, record.SourceID)
			} else if rule, err := registry.DecodeRuleStrict(source.Raw); err != nil {
				record.Category = "Rejected"
				record.Errors = strictRecordErrors(record.SourceID, source.Line, source.Index, err)
			} else {
				record.SourceID = rule.RuleID
				record.RecordID = "rule:" + rule.RuleID
				record.Rule = &rule
			}
		}
		out = append(out, record)
	}
	return out
}

func (s *Service) validateAndDiff(input AnalyseInput, records []ImportRecord) Preview {
	preview := emptyPreview()
	activeTools := s.manager.Tools()
	activeRules := s.manager.Rules()
	toolByID := map[string]registry.Tool{}
	toolByName := map[string]registry.Tool{}
	for _, tool := range activeTools {
		toolByID[normalKey(tool.ToolID)] = tool
		toolByName[normalKey(tool.Name)] = tool
	}
	ruleByID := map[string]registry.Rule{}
	for _, rule := range activeRules {
		ruleByID[normalKey(rule.RuleID)] = rule
	}

	seenIDs := map[string]bool{}
	seenNames := map[string]bool{}
	candidateTools := append([]registry.Tool{}, activeTools...)
	for index := range records {
		record := records[index]
		if record.Category == "Rejected" {
			preview.Rejected = append(preview.Rejected, record)
			continue
		}
		if record.Tool == nil {
			continue
		}
		record.Errors = append(record.Errors, validateTool(*record.Tool, record.Line, record.Index)...)
		idKey := normalKey(record.Tool.ToolID)
		nameKey := normalKey(record.Tool.Name)
		if seenIDs[idKey] {
			record.Errors = append(record.Errors, RecordError{RecordID: record.SourceID, Line: record.Line, Index: record.Index, Field: "tool_id", Reason: "is duplicated in the uploaded file"})
		}
		if seenNames[nameKey] {
			record.Errors = append(record.Errors, RecordError{RecordID: record.SourceID, Line: record.Line, Index: record.Index, Field: "name", Reason: "is duplicated in the uploaded file"})
		}
		seenIDs[idKey] = true
		seenNames[nameKey] = true
		existingByID, idExists := toolByID[idKey]
		existingByName, nameExists := toolByName[nameKey]
		if nameExists && (!idExists || !strings.EqualFold(existingByName.ToolID, record.Tool.ToolID)) {
			record.Errors = append(record.Errors, RecordError{RecordID: record.SourceID, Line: record.Line, Index: record.Index, Field: "name", Reason: fmt.Sprintf("collides with active tool %s and cannot update a different tool_id", existingByName.ToolID)})
		}
		if len(record.Errors) > 0 {
			record.Category = "Rejected"
			preview.Rejected = append(preview.Rejected, record)
			continue
		}
		if idExists {
			record.Changes = fieldChanges(existingByID, *record.Tool)
			if len(record.Changes) == 0 {
				record.Category = "Unchanged"
				preview.Unchanged = append(preview.Unchanged, record)
			} else if !input.AllowUpdates {
				record.Category = "Rejected"
				record.Errors = append(record.Errors, RecordError{RecordID: record.SourceID, Line: record.Line, Index: record.Index, Field: "tool_id", Reason: "changes an active tool; explicitly allow updates before analysing"})
				preview.Rejected = append(preview.Rejected, record)
			} else {
				record.Category = "Updated"
				preview.Updated = append(preview.Updated, record)
				candidateTools = replaceProspectiveTool(candidateTools, *record.Tool)
			}
		} else {
			record.Category = "Added"
			preview.Added = append(preview.Added, record)
			candidateTools = append(candidateTools, *record.Tool)
		}
	}

	seenRuleIDs := map[string]bool{}
	for index := range records {
		record := records[index]
		if record.Rule == nil || record.Category == "Rejected" {
			continue
		}
		idKey := normalKey(record.Rule.RuleID)
		if seenRuleIDs[idKey] {
			record.Errors = append(record.Errors, RecordError{RecordID: record.SourceID, Line: record.Line, Index: record.Index, Field: "rule_id", Reason: "is duplicated in the uploaded file"})
		}
		seenRuleIDs[idKey] = true
		record.Errors = append(record.Errors, validateRule(*record.Rule, candidateTools, record.Line, record.Index)...)
		if len(record.Errors) > 0 {
			record.Category = "Rejected"
			preview.Rejected = append(preview.Rejected, record)
			continue
		}
		if existing, exists := ruleByID[idKey]; exists {
			record.Changes = fieldChanges(existing, *record.Rule)
			if len(record.Changes) == 0 {
				record.Category = "Unchanged"
				preview.Unchanged = append(preview.Unchanged, record)
			} else {
				record.Category = "Updated"
				preview.Updated = append(preview.Updated, record)
			}
		} else {
			record.Category = "Added"
			preview.Added = append(preview.Added, record)
		}
	}

	for _, rule := range activeRules {
		if ruleMatchesAnyTool(rule, activeTools) && !ruleMatchesAnyTool(rule, candidateTools) {
			ruleCopy := rule
			preview.Orphaned = append(preview.Orphaned, ImportRecord{
				RecordID: "orphaned:" + rule.RuleID, RegistryKind: SourceRules, SourceID: rule.RuleID,
				Category: "Orphaned", Rule: &ruleCopy, Changes: []FieldChange{}, Errors: []RecordError{{
					RecordID: rule.RuleID, Index: -1, Field: "applies_to_tools", Reason: "would match zero tools after this import",
				}},
			})
		}
	}
	return preview
}

func (s *Service) Commit(analysisID string, options CommitOptions) (CommitResult, error) {
	if s == nil || s.manager == nil {
		return CommitResult{}, errors.New("registry import service is not configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	analysis := s.analyses[analysisID]
	if analysis == nil {
		return CommitResult{}, errors.New("import analysis was not found or has expired")
	}
	selected := map[string]bool{}
	for _, id := range options.SelectedRecordIDs {
		selected[id] = true
	}
	records := selectedRecords(analysis.Preview, selected)
	if len(records) == 0 {
		return CommitResult{}, errors.New("select at least one added or updated record to commit")
	}
	if len(records) != len(selected) {
		return CommitResult{}, errors.New("selection contains a rejected, unchanged, orphaned, or unknown record")
	}
	prospectiveTools := append([]registry.Tool{}, s.manager.Tools()...)
	for _, record := range records {
		if record.Tool != nil {
			prospectiveTools = replaceProspectiveTool(prospectiveTools, *record.Tool)
		}
	}
	for _, record := range records {
		if record.Rule != nil && !ruleMatchesAnyTool(*record.Rule, prospectiveTools) {
			return CommitResult{}, fmt.Errorf("record %s cannot be committed because applies_to_tools matches zero selected or active tools", record.RecordID)
		}
	}
	for _, rule := range s.manager.Rules() {
		if ruleMatchesAnyTool(rule, s.manager.Tools()) && !ruleMatchesAnyTool(rule, prospectiveTools) {
			return CommitResult{}, fmt.Errorf("record selection would orphan existing rule %s", rule.RuleID)
		}
	}

	toolPath, rulePath := s.manager.RegistryPaths()
	if err := validateCommitPaths(toolPath, rulePath); err != nil {
		return CommitResult{}, err
	}
	toolBackup, err := createRegistryBackup(toolPath)
	if err != nil {
		return CommitResult{}, fmt.Errorf("back up tool registry: %w", err)
	}
	defer toolBackup.cleanup()
	ruleBackup, err := createRegistryBackup(rulePath)
	if err != nil {
		return CommitResult{}, fmt.Errorf("back up rule registry: %w", err)
	}
	defer ruleBackup.cleanup()

	sort.SliceStable(records, func(i, j int) bool {
		return records[i].RegistryKind == SourceTools && records[j].RegistryKind == SourceRules
	})
	callbackSuspension := s.manager.SuspendToolUpsertCallback()
	defer callbackSuspension.Restore()
	appliedTools := []registry.Tool{}
	committedIDs := make([]string, 0, len(records))
	for _, record := range records {
		raw, marshalErr := recordJSON(record)
		if marshalErr != nil {
			restoreErr := s.rollback(toolBackup, ruleBackup)
			return CommitResult{}, commitFailure(record.RecordID, marshalErr, restoreErr)
		}
		var applyErr error
		if record.Tool != nil {
			if record.Category == "Updated" {
				_, applyErr = s.manager.UpdateTool(record.Tool.ToolID, raw)
			} else {
				_, applyErr = s.manager.AddTool(raw)
			}
			if applyErr == nil {
				appliedTools = append(appliedTools, *record.Tool)
			}
		} else if record.Rule != nil {
			if record.Category == "Updated" {
				_, applyErr = s.manager.UpdateRule(record.Rule.RuleID, raw)
			} else {
				_, applyErr = s.manager.AddRule(raw)
			}
		}
		if applyErr != nil {
			restoreErr := s.rollback(toolBackup, ruleBackup)
			return CommitResult{}, commitFailure(record.RecordID, applyErr, restoreErr)
		}
		committedIDs = append(committedIDs, record.RecordID)
	}
	if s.context == nil {
		restoreErr := s.rollback(toolBackup, ruleBackup)
		return CommitResult{}, commitFailure("registry_context", errors.New("registry generation context is not configured"), restoreErr)
	}
	if _, contextErr := s.context.Regenerate(); contextErr != nil {
		restoreErr := s.rollback(toolBackup, ruleBackup)
		return CommitResult{}, commitFailure("registry_context", contextErr, restoreErr)
	}
	callbackSuspension.RestoreAndNotify(appliedTools)

	committedAt := time.Now().UTC()
	counts := previewCounts(analysis.Preview)
	result := CommitResult{
		AnalysisID: analysis.ID, Filename: analysis.Filename, FileSHA256: analysis.FileSHA256,
		ResultingHash: s.manager.Hash(), CommittedRecordID: committedIDs,
		Counts: counts, CommittedAt: committedAt,
	}
	responseSchemas := map[string]interface{}{}
	for _, record := range records {
		if schema, exists := record.Metadata["response_schema"]; exists {
			responseSchemas[record.RecordID] = schema
		}
	}
	s.history = append([]HistoryEntry{{
		AnalysisID: analysis.ID, ActorID: options.ActorID, ActorName: options.ActorName,
		Filename: analysis.Filename, FileSHA256: analysis.FileSHA256, Counts: counts,
		Diff: analysis.Preview, ResponseSchemas: responseSchemas, ResultingHash: result.ResultingHash, CommittedAt: committedAt,
	}}, s.history...)
	analysis.Stages[4].Status = "confirmed"
	analysis.Stages[5].Status = "complete"
	return result, nil
}

func (s *Service) History() []HistoryEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, _ := json.Marshal(s.history)
	var out []HistoryEntry
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		return []HistoryEntry{}
	}
	return out
}

func (s *Service) rollback(toolBackup, ruleBackup registryBackup) error {
	toolErr := toolBackup.restore()
	ruleErr := ruleBackup.restore()
	if toolErr == nil && ruleErr == nil {
		restored, err := registry.LoadBundle(toolBackup.path, ruleBackup.path, s.log)
		if err != nil {
			return fmt.Errorf("reload restored registry: %w", err)
		}
		return s.manager.RepublishRestoredBundle(restored)
	}
	return errors.Join(toolErr, ruleErr)
}

type registryBackup struct {
	path       string
	backupPath string
	raw        []byte
	existed    bool
	mode       os.FileMode
}

func createRegistryBackup(path string) (registryBackup, error) {
	info, statErr := os.Stat(path)
	existed := statErr == nil
	if statErr != nil && !os.IsNotExist(statErr) {
		return registryBackup{}, statErr
	}
	raw := []byte{}
	mode := os.FileMode(0o600)
	if existed {
		var err error
		raw, err = os.ReadFile(path)
		if err != nil {
			return registryBackup{}, err
		}
		mode = info.Mode().Perm()
	}
	backupFile, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".import-backup-*")
	if err != nil {
		return registryBackup{}, err
	}
	backupPath := backupFile.Name()
	if _, err := backupFile.Write(raw); err != nil {
		backupFile.Close()
		os.Remove(backupPath)
		return registryBackup{}, err
	}
	if err := backupFile.Sync(); err != nil {
		backupFile.Close()
		os.Remove(backupPath)
		return registryBackup{}, err
	}
	if err := backupFile.Close(); err != nil {
		os.Remove(backupPath)
		return registryBackup{}, err
	}
	return registryBackup{path: path, backupPath: backupPath, raw: raw, existed: existed, mode: mode}, nil
}

func (backup registryBackup) restore() error {
	if err := registry.GuardRegistryWritePath(backup.path); err != nil {
		return err
	}
	if !backup.existed {
		if err := os.Remove(backup.path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove newly created registry %s: %w", backup.path, err)
		}
		return nil
	}
	temp, err := os.CreateTemp(filepath.Dir(backup.path), filepath.Base(backup.path)+".restore-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if _, err := temp.Write(backup.raw); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Chmod(backup.mode); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	displaced := backup.path + ".failed-import"
	_ = os.Remove(displaced)
	if err := os.Rename(backup.path, displaced); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Rename(tempPath, backup.path); err != nil {
		_ = os.Rename(displaced, backup.path)
		return err
	}
	_ = os.Remove(displaced)
	return nil
}

func (backup registryBackup) cleanup() {
	if backup.backupPath != "" {
		_ = os.Remove(backup.backupPath)
	}
}

func validateCommitPaths(toolPath, rulePath string) error {
	if strings.TrimSpace(toolPath) == "" || strings.TrimSpace(rulePath) == "" {
		return errors.New("tool and rule registry paths must both be configured")
	}
	for _, path := range []string{toolPath, rulePath} {
		if err := registry.GuardRegistryWritePath(path); err != nil {
			return err
		}
		normalised := "/" + strings.TrimPrefix(strings.ToLower(filepath.ToSlash(filepath.Clean(path))), "/")
		switch {
		case strings.Contains(normalised, "/configs/seed/"):
			return fmt.Errorf("import commits cannot write seed path %s", path)
		case strings.Contains(normalised, "/dataset/eval/"):
			return fmt.Errorf("import commits cannot write evaluation dataset path %s", path)
		case strings.Contains(normalised, "/cmd/run-experiment/"):
			return fmt.Errorf("import commits cannot write experiment command path %s", path)
		}
	}
	return nil
}

func selectedRecords(preview Preview, selected map[string]bool) []ImportRecord {
	out := []ImportRecord{}
	for _, group := range [][]ImportRecord{preview.Added, preview.Updated} {
		for _, record := range group {
			if selected[record.RecordID] {
				out = append(out, record)
			}
		}
	}
	return out
}

func recordJSON(record ImportRecord) ([]byte, error) {
	if record.Tool != nil {
		return json.Marshal(record.Tool)
	}
	if record.Rule != nil {
		return json.Marshal(record.Rule)
	}
	return nil, errors.New("record has no normalised registry value")
}

func commitFailure(recordID string, applyErr, restoreErr error) error {
	if restoreErr != nil {
		return fmt.Errorf("record %s failed: %v; rollback also failed: %w", recordID, applyErr, restoreErr)
	}
	return fmt.Errorf("record %s failed and both registry backups were restored: %w", recordID, applyErr)
}

func replaceProspectiveTool(tools []registry.Tool, replacement registry.Tool) []registry.Tool {
	out := append([]registry.Tool{}, tools...)
	for index, tool := range out {
		if strings.EqualFold(tool.ToolID, replacement.ToolID) {
			out[index] = replacement
			return out
		}
	}
	return append(out, replacement)
}

func previewCounts(preview Preview) map[string]int {
	return map[string]int{
		"added": len(preview.Added), "updated": len(preview.Updated), "unchanged": len(preview.Unchanged),
		"rejected": len(preview.Rejected), "orphaned": len(preview.Orphaned),
	}
}

func fileRejection(kind SourceKind, err error) ImportRecord {
	return ImportRecord{
		RecordID: "file:0", RegistryKind: kind, SourceID: "file", Line: 1, Index: 0, Category: "Rejected",
		Changes: []FieldChange{}, Errors: []RecordError{{RecordID: "file", Line: 1, Index: 0, Field: "file", Reason: err.Error()}},
	}
}

func strictRecordErrors(recordID string, line, index int, err error) []RecordError {
	message := err.Error()
	if marker := strings.Index(message, "required fields missing: "); marker >= 0 {
		fields := strings.Split(message[marker+len("required fields missing: "):], ",")
		out := make([]RecordError, 0, len(fields))
		for _, field := range fields {
			out = append(out, RecordError{RecordID: recordID, Line: line, Index: index, Field: strings.TrimSpace(field), Reason: "required field is missing"})
		}
		return out
	}
	field := "record"
	unknownPattern := regexp.MustCompile(`unknown field "([^"]+)"`)
	if match := unknownPattern.FindStringSubmatch(message); len(match) == 2 {
		field = match[1]
	}
	return []RecordError{{RecordID: recordID, Line: line, Index: index, Field: field, Reason: message}}
}

func sourceErrorsForRecord(errorsFound []RecordError, recordID string) []RecordError {
	out := append([]RecordError{}, errorsFound...)
	for index := range out {
		out[index].RecordID = recordID
	}
	return out
}

func sourceIdentifier(raw []byte, field string) string {
	var value map[string]interface{}
	if json.Unmarshal(raw, &value) == nil {
		if text, ok := value[field].(string); ok {
			return text
		}
	}
	return ""
}

func recordIdentifier(prefix, sourceID string, index int) string {
	if strings.TrimSpace(sourceID) != "" {
		return prefix + ":" + sourceID
	}
	return fmt.Sprintf("%s:index:%d", prefix, index)
}

func normalKey(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func randomAnalysisID() string {
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("analysis-%d", time.Now().UnixNano())
	}
	return "analysis-" + hex.EncodeToString(buffer)
}

func cloneAnalysisPointer(value *Analysis) *Analysis {
	raw, _ := json.Marshal(value)
	var out Analysis
	_ = json.Unmarshal(raw, &out)
	return &out
}
