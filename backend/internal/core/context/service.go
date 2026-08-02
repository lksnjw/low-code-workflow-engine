package context

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"go.uber.org/zap"
)

type Service struct {
	mu        sync.Mutex
	manager   *registry.Manager
	sizeCap   int
	now       func() time.Time
	writeFile func(string, []byte) error
	log       *zap.Logger
}

type fileSnapshot struct {
	path    string
	raw     []byte
	mode    os.FileMode
	existed bool
}

func NewService(manager *registry.Manager, log *zap.Logger) *Service {
	if log == nil {
		log = zap.NewNop()
	}
	return &Service{
		manager:   manager,
		sizeCap:   DefaultSizeCap,
		now:       time.Now,
		writeFile: atomicWriteFile,
		log:       log,
	}
}

func (s *Service) Regenerate() (Document, error) {
	if s == nil {
		return Document{}, errors.New("registry context service is not configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.regenerateLocked()
}

func (s *Service) Current() (Document, error) {
	if s == nil {
		return Document{}, errors.New("registry context service is not configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.currentLocked()
}

// PromptContext is the only generated-context read used by synthesis. It
// verifies the typed registry hash first and synchronously regenerates stale
// content before returning selected generation context.
func (s *Service) PromptContext(domains []string) (string, error) {
	if s == nil {
		return "", errors.New("registry context service is not configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	document, err := s.currentLocked()
	if err != nil || document.Stale {
		document, err = s.regenerateLocked()
		if err != nil {
			return "", fmt.Errorf("regenerate stale registry generation context: %w", err)
		}
	}
	return selectPromptBody(document, domains), nil
}

func (s *Service) History() ([]Document, error) {
	if s == nil {
		return nil, errors.New("registry context service is not configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	currentPath, _, err := s.pathsLocked(s.manager.Hash())
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(filepath.Dir(currentPath))
	if err != nil {
		if os.IsNotExist(err) {
			return []Document{}, nil
		}
		return nil, err
	}
	history := []Document{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "registry_context_") || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		path := filepath.Join(filepath.Dir(currentPath), entry.Name())
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil, readErr
		}
		document, parseErr := Parse(raw)
		if parseErr != nil {
			return nil, fmt.Errorf("parse registry context history %s: %w", path, parseErr)
		}
		document.Path = path
		document.Stale = document.FrontMatter.RegistryHash != s.manager.Hash()
		history = append(history, document)
	}
	sort.Slice(history, func(i, j int) bool {
		return history[i].FrontMatter.GeneratedAt > history[j].FrontMatter.GeneratedAt
	})
	return history, nil
}

func (s *Service) AddTool(raw []byte) (registry.MutationResult[registry.Tool], error) {
	return s.mutateTool(func() (registry.MutationResult[registry.Tool], error) {
		return s.manager.AddTool(raw)
	})
}

func (s *Service) UpdateTool(id string, raw []byte) (registry.MutationResult[registry.Tool], error) {
	return s.mutateTool(func() (registry.MutationResult[registry.Tool], error) {
		return s.manager.UpdateTool(id, raw)
	})
}

func (s *Service) AddRule(raw []byte) (registry.MutationResult[registry.Rule], error) {
	return s.mutateRule(func() (registry.MutationResult[registry.Rule], error) {
		return s.manager.AddRule(raw)
	})
}

func (s *Service) UpdateRule(id string, raw []byte) (registry.MutationResult[registry.Rule], error) {
	return s.mutateRule(func() (registry.MutationResult[registry.Rule], error) {
		return s.manager.UpdateRule(id, raw)
	})
}

// ImportTools applies a validated tool batch and regenerates the generation
// context as one rollback-protected operation.
func (s *Service) ImportTools(raw []byte, allowUpdates bool) (registry.BulkMutationResult[registry.Tool], []registry.BulkImportError, error) {
	if s == nil || s.manager == nil {
		return registry.BulkMutationResult[registry.Tool]{}, nil, errors.New("registry context service is not configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.ensureCurrentLocked(); err != nil {
		return registry.BulkMutationResult[registry.Tool]{}, nil, err
	}
	snapshots, err := s.registrySnapshotsLocked()
	if err != nil {
		return registry.BulkMutationResult[registry.Tool]{}, nil, err
	}
	callback := s.manager.SuspendToolUpsertCallback()
	defer callback.Restore()
	result, validationErrors, err := s.manager.ImportTools(raw, allowUpdates)
	if err != nil || len(validationErrors) > 0 {
		return result, validationErrors, err
	}
	if _, err := s.regenerateLocked(); err != nil {
		restoreErr := s.restoreRegistryLocked(snapshots)
		return registry.BulkMutationResult[registry.Tool]{}, nil, mutationContextError(err, restoreErr)
	}
	callback.RestoreAndNotify(result.Items)
	return result, nil, nil
}

// ImportRules applies a validated rule batch and regenerates the generation
// context as one rollback-protected operation.
func (s *Service) ImportRules(raw []byte, allowUpdates bool) (registry.BulkMutationResult[registry.Rule], []registry.BulkImportError, error) {
	if s == nil || s.manager == nil {
		return registry.BulkMutationResult[registry.Rule]{}, nil, errors.New("registry context service is not configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.ensureCurrentLocked(); err != nil {
		return registry.BulkMutationResult[registry.Rule]{}, nil, err
	}
	snapshots, err := s.registrySnapshotsLocked()
	if err != nil {
		return registry.BulkMutationResult[registry.Rule]{}, nil, err
	}
	result, validationErrors, err := s.manager.ImportRules(raw, allowUpdates)
	if err != nil || len(validationErrors) > 0 {
		return result, validationErrors, err
	}
	if _, err := s.regenerateLocked(); err != nil {
		restoreErr := s.restoreRegistryLocked(snapshots)
		return registry.BulkMutationResult[registry.Rule]{}, nil, mutationContextError(err, restoreErr)
	}
	return result, nil, nil
}

func (s *Service) mutateTool(operation func() (registry.MutationResult[registry.Tool], error)) (registry.MutationResult[registry.Tool], error) {
	if s == nil || s.manager == nil {
		return registry.MutationResult[registry.Tool]{}, errors.New("registry context service is not configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.ensureCurrentLocked(); err != nil {
		return registry.MutationResult[registry.Tool]{}, err
	}
	snapshots, err := s.registrySnapshotsLocked()
	if err != nil {
		return registry.MutationResult[registry.Tool]{}, err
	}
	callback := s.manager.SuspendToolUpsertCallback()
	defer callback.Restore()
	result, err := operation()
	if err != nil {
		return registry.MutationResult[registry.Tool]{}, err
	}
	if _, err := s.regenerateLocked(); err != nil {
		restoreErr := s.restoreRegistryLocked(snapshots)
		return registry.MutationResult[registry.Tool]{}, mutationContextError(err, restoreErr)
	}
	callback.RestoreAndNotify([]registry.Tool{result.Item})
	return result, nil
}

func (s *Service) mutateRule(operation func() (registry.MutationResult[registry.Rule], error)) (registry.MutationResult[registry.Rule], error) {
	if s == nil || s.manager == nil {
		return registry.MutationResult[registry.Rule]{}, errors.New("registry context service is not configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.ensureCurrentLocked(); err != nil {
		return registry.MutationResult[registry.Rule]{}, err
	}
	snapshots, err := s.registrySnapshotsLocked()
	if err != nil {
		return registry.MutationResult[registry.Rule]{}, err
	}
	result, err := operation()
	if err != nil {
		return registry.MutationResult[registry.Rule]{}, err
	}
	if _, err := s.regenerateLocked(); err != nil {
		restoreErr := s.restoreRegistryLocked(snapshots)
		return registry.MutationResult[registry.Rule]{}, mutationContextError(err, restoreErr)
	}
	return result, nil
}

func (s *Service) ensureCurrentLocked() (Document, error) {
	document, err := s.currentLocked()
	if err == nil && !document.Stale {
		return document, nil
	}
	return s.regenerateLocked()
}

func (s *Service) currentLocked() (Document, error) {
	if s.manager == nil {
		return Document{}, errors.New("registry manager is not configured")
	}
	currentPath, _, err := s.pathsLocked(s.manager.Hash())
	if err != nil {
		return Document{}, err
	}
	raw, err := os.ReadFile(currentPath)
	if err != nil {
		return Document{}, err
	}
	document, err := Parse(raw)
	if err != nil {
		return Document{}, err
	}
	document.Path = currentPath
	document.Stale = document.FrontMatter.RegistryHash != s.manager.Hash()
	return document, nil
}

func (s *Service) regenerateLocked() (Document, error) {
	if s.manager == nil {
		return Document{}, errors.New("registry manager is not configured")
	}
	toolPath, rulePath := s.manager.RegistryPaths()
	toolHash, err := registryFileSHA256(toolPath)
	if err != nil {
		return Document{}, fmt.Errorf("hash runtime tool registry: %w", err)
	}
	ruleHash, err := registryFileSHA256(rulePath)
	if err != nil {
		return Document{}, fmt.Errorf("hash runtime rule registry: %w", err)
	}
	document, err := Render(RenderInput{
		RegistryHash:       s.manager.Hash(),
		ToolRegistrySHA256: toolHash,
		RuleRegistrySHA256: ruleHash,
		GeneratedAt:        s.now().UTC(),
		Tools:              s.manager.Tools(),
		Rules:              s.manager.Rules(),
		SizeCapBytes:       s.sizeCap,
	})
	if err != nil {
		return Document{}, err
	}
	currentPath, archivePath, err := s.pathsLocked(document.FrontMatter.RegistryHash)
	if err != nil {
		return Document{}, err
	}
	if err := s.writeDocumentsLocked(currentPath, archivePath, []byte(document.Markdown)); err != nil {
		return Document{}, err
	}
	document.Path = currentPath
	s.log.Info("runtime registry generation context regenerated",
		zap.String("path", currentPath),
		zap.String("registry_hash", document.FrontMatter.RegistryHash),
		zap.Int("size_bytes", document.SizeBytes),
	)
	return document, nil
}

func (s *Service) writeDocumentsLocked(currentPath, archivePath string, raw []byte) error {
	for _, path := range []string{currentPath, archivePath} {
		if err := registry.GuardRegistryWritePath(path); err != nil {
			return err
		}
	}
	currentSnapshot, err := captureFile(currentPath)
	if err != nil {
		return err
	}
	archiveSnapshot, err := captureFile(archivePath)
	if err != nil {
		return err
	}
	if !archiveSnapshot.existed {
		if err := s.writeFile(archivePath, raw); err != nil {
			return fmt.Errorf("write registry context archive: %w", err)
		}
	}
	if err := s.writeFile(currentPath, raw); err != nil {
		restoreErr := restoreFile(archiveSnapshot)
		restoreErr = errors.Join(restoreErr, restoreFile(currentSnapshot))
		return errors.Join(fmt.Errorf("write current registry context: %w", err), restoreErr)
	}
	return nil
}

func (s *Service) pathsLocked(registryHash string) (string, string, error) {
	if s.manager == nil {
		return "", "", errors.New("registry manager is not configured")
	}
	toolPath, _ := s.manager.RegistryPaths()
	if strings.TrimSpace(toolPath) == "" {
		return "", "", errors.New("runtime tool registry path is not configured")
	}
	hash := strings.TrimPrefix(strings.TrimSpace(registryHash), "sha256:")
	if len(hash) < 8 {
		return "", "", fmt.Errorf("registry hash %q does not contain eight hexadecimal characters", registryHash)
	}
	dir := filepath.Dir(toolPath)
	currentPath := filepath.Join(dir, "registry_context.md")
	archivePath := filepath.Join(dir, "registry_context_"+hash[:8]+".md")
	return currentPath, archivePath, nil
}

func (s *Service) registrySnapshotsLocked() ([]fileSnapshot, error) {
	toolPath, rulePath := s.manager.RegistryPaths()
	snapshots := make([]fileSnapshot, 0, 2)
	for _, path := range []string{toolPath, rulePath} {
		if err := registry.GuardRegistryWritePath(path); err != nil {
			return nil, err
		}
		snapshot, err := captureFile(path)
		if err != nil {
			return nil, err
		}
		snapshots = append(snapshots, snapshot)
	}
	return snapshots, nil
}

func (s *Service) restoreRegistryLocked(snapshots []fileSnapshot) error {
	var restoreErr error
	for _, snapshot := range snapshots {
		restoreErr = errors.Join(restoreErr, restoreFile(snapshot))
	}
	if restoreErr != nil {
		return restoreErr
	}
	toolPath, rulePath := s.manager.RegistryPaths()
	restored, err := registry.LoadBundle(toolPath, rulePath, s.log)
	if err != nil {
		return err
	}
	return s.manager.RepublishRestoredBundle(restored)
}

func captureFile(path string) (fileSnapshot, error) {
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return fileSnapshot{path: path, mode: 0o600}, nil
	}
	if err != nil {
		return fileSnapshot{}, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return fileSnapshot{}, err
	}
	return fileSnapshot{path: path, raw: raw, mode: info.Mode().Perm(), existed: true}, nil
}

func restoreFile(snapshot fileSnapshot) error {
	if err := registry.GuardRegistryWritePath(snapshot.path); err != nil {
		return err
	}
	if !snapshot.existed {
		if err := os.Remove(snapshot.path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	return atomicWriteFileMode(snapshot.path, snapshot.raw, snapshot.mode)
}

func atomicWriteFile(path string, raw []byte) error {
	return atomicWriteFileMode(path, raw, 0o600)
}

func atomicWriteFileMode(path string, raw []byte, mode os.FileMode) error {
	if err := registry.GuardRegistryWritePath(path); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if _, err := temp.Write(raw); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Chmod(mode); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	displaced := path + ".context-backup"
	_ = os.Remove(displaced)
	if err := os.Rename(path, displaced); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		_ = os.Rename(displaced, path)
		return err
	}
	_ = os.Remove(displaced)
	return nil
}

func registryFileSHA256(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return fmt.Sprintf("%x", sum), nil
}

func mutationContextError(regenerationErr, restoreErr error) error {
	if restoreErr != nil {
		return fmt.Errorf("registry context regeneration failed: %v; registry rollback failed: %w", regenerationErr, restoreErr)
	}
	return fmt.Errorf("registry context regeneration failed and registry mutation was rolled back: %w", regenerationErr)
}

func selectPromptBody(document Document, domains []string) string {
	selected := map[string]bool{}
	for _, domain := range domains {
		domain = strings.ToLower(strings.TrimSpace(domain))
		if domain != "" {
			selected[domain] = true
		}
	}
	if len(selected) == 0 {
		return "registry_hash: " + document.FrontMatter.RegistryHash + "\n\n" + document.Body
	}
	lines := strings.Split(document.Body, "\n")
	var out strings.Builder
	fmt.Fprintf(&out, "registry_hash: %s\n\n# Runtime Registry Generation Context\n\n## 2. TOOL CATALOGUE\n\n", document.FrontMatter.RegistryHash)
	inCatalogue := false
	includeDomain := false
	for _, line := range lines {
		if line == "## 2. TOOL CATALOGUE" {
			inCatalogue = true
			continue
		}
		if inCatalogue && strings.HasPrefix(line, "## ") {
			inCatalogue = false
		}
		if inCatalogue && strings.HasPrefix(line, "### ") {
			name := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(line, "### "), "(name-only)"))
			includeDomain = selected[strings.ToLower(strings.TrimSpace(name))]
		}
		if inCatalogue && includeDomain {
			out.WriteString(line)
			out.WriteByte('\n')
		}
	}
	for _, section := range []string{"## 3. POLICY CONSTRAINTS", "## 4. PROCESS CONSTRAINTS", "## 5. SENSITIVE FIELDS"} {
		if block := markdownSection(document.Body, section); block != "" {
			out.WriteByte('\n')
			out.WriteString(block)
		}
	}
	return out.String()
}

func markdownSection(body, header string) string {
	start := strings.Index(body, header)
	if start < 0 {
		return ""
	}
	rest := body[start+len(header):]
	if next := strings.Index(rest, "\n## "); next >= 0 {
		return body[start : start+len(header)+next+1]
	}
	return body[start:]
}
