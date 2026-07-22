package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/storage"
)

const (
	persistedStateVersion  = 1
	persistenceSaveTimeout = 2 * time.Second
)

// StoreMutex preserves the sync.RWMutex API used by handlers while adding a
// synchronous durability hook after each write. The hook runs while the write
// lock is still held, so the serialized snapshot is internally consistent.
type StoreMutex struct {
	mutex    sync.RWMutex
	onUnlock func()
}

func (m *StoreMutex) Lock()    { m.mutex.Lock() }
func (m *StoreMutex) RLock()   { m.mutex.RLock() }
func (m *StoreMutex) RUnlock() { m.mutex.RUnlock() }

func (m *StoreMutex) Unlock() {
	if m.onUnlock != nil {
		m.onUnlock()
	}
	m.mutex.Unlock()
}

type persistenceHook struct {
	stateStore        storage.StateStore
	codec             storage.Codec
	onError           func(error)
	committedState    []byte
	failureGeneration atomic.Uint64
	healthMu          sync.RWMutex
	healthy           bool
}

// NewPersistentStore restores an encrypted snapshot and attaches synchronous
// persistence to all subsequent map mutations. A new database is initialized
// with the normal authorization policy definitions from NewStore.
func NewPersistentStore(ctx context.Context, stateStore storage.StateStore, codec storage.Codec, onError func(error)) (*Store, error) {
	if stateStore == nil {
		return nil, fmt.Errorf("persistent store requires a state backend")
	}
	if codec == nil {
		return nil, fmt.Errorf("persistent store requires an encryption codec")
	}

	store := NewStore()
	payload, found, err := stateStore.Load(ctx)
	if err != nil {
		return nil, err
	}
	if found {
		plaintext, err := codec.Decode(payload)
		if err != nil {
			return nil, fmt.Errorf("decode persisted runtime state: %w", err)
		}
		if err := restoreState(store, plaintext); err != nil {
			return nil, err
		}
	}

	store.persist = &persistenceHook{stateStore: stateStore, codec: codec, onError: onError, healthy: true}
	store.Mu.onUnlock = func() {
		persistContext, cancel := context.WithTimeout(context.Background(), persistenceSaveTimeout)
		defer cancel()
		err := store.persistLocked(persistContext)
		if err == nil {
			store.persist.setHealthy(true)
			return
		}
		if rollbackErr := store.rollbackLocked(); rollbackErr != nil {
			err = errors.Join(err, fmt.Errorf("rollback failed mutation: %w", rollbackErr))
		}
		store.persist.setHealthy(false)
		store.persist.failureGeneration.Add(1)
		if store.persist.onError != nil {
			store.persist.onError(err)
		}
	}
	// Persist both new stores and normalized v1 restores. This makes startup
	// fail closed when the database is readable but not writable and records
	// newly required policy definitions immediately.
	if err := store.persistLocked(ctx); err != nil {
		return nil, err
	}
	return store, nil
}

// PersistenceStatus reports whether durable storage is attached and whether
// the most recent synchronous save succeeded. Memory stores are healthy but
// not durable.
func (s *Store) PersistenceStatus() (durable, healthy bool) {
	if s == nil || s.persist == nil {
		return false, true
	}
	s.persist.healthMu.RLock()
	defer s.persist.healthMu.RUnlock()
	return true, s.persist.healthy
}

// ProbePersistence actively verifies the durable backend and refreshes the
// health state. The failure generation remains monotonic so request middleware
// can still detect an earlier failed mutation after connectivity recovers.
func (s *Store) ProbePersistence(ctx context.Context) (durable, healthy bool) {
	if s == nil || s.persist == nil {
		return false, true
	}
	err := s.persist.stateStore.Probe(ctx)
	s.persist.setHealthy(err == nil)
	return true, err == nil
}

// PersistenceFailureGeneration increments after every failed synchronous save.
// It is intentionally monotonic and safe to read without taking Store.Mu.
func (s *Store) PersistenceFailureGeneration() uint64 {
	if s == nil || s.persist == nil {
		return 0
	}
	return s.persist.failureGeneration.Load()
}

func (p *persistenceHook) setHealthy(healthy bool) {
	p.healthMu.Lock()
	p.healthy = healthy
	p.healthMu.Unlock()
}

// Close releases the underlying storage connection. Writes are synchronously
// persisted at Unlock, so no additional unlocked flush is necessary here.
func (s *Store) Close() {
	if s != nil && s.persist != nil && s.persist.stateStore != nil {
		s.persist.stateStore.Close()
	}
}

func (s *Store) persistLocked(ctx context.Context) error {
	plaintext, err := marshalState(s)
	if err != nil {
		return err
	}
	payload, err := s.persist.codec.Encode(plaintext)
	if err != nil {
		return fmt.Errorf("encrypt runtime state: %w", err)
	}
	if err := s.persist.stateStore.Save(ctx, payload); err != nil {
		return err
	}
	s.persist.committedState = append(s.persist.committedState[:0], plaintext...)
	return nil
}

func (s *Store) rollbackLocked() error {
	if s == nil || s.persist == nil || len(s.persist.committedState) == 0 {
		return fmt.Errorf("no committed runtime state is available")
	}
	return restoreState(s, s.persist.committedState)
}

type storedWorkflow struct {
	models.Workflow
	YAML     string                `json:"yaml"`
	Canvas   models.WorkflowCanvas `json:"canvas"`
	Archived bool                  `json:"archived"`
}

type storedProvider struct {
	models.ProviderConfig
	APIKey string `json:"apiKey"`
}

type storedAPIKey struct {
	models.APIKey
	Key string `json:"key"`
}

type persistedState struct {
	Version                 int                                       `json:"version"`
	Counter                 uint64                                    `json:"counter"`
	Users                   map[string]*models.User                   `json:"users"`
	PasswordHashes          map[string]string                         `json:"passwordHashes"`
	RefreshSessions         map[string]RefreshSession                 `json:"refreshSessions"`
	Roles                   map[string]*models.Role                   `json:"roles"`
	Permissions             []models.Permission                       `json:"permissions"`
	Workflows               map[string]*storedWorkflow                `json:"workflows"`
	Versions                map[string][]models.WorkflowVersion       `json:"versions"`
	Templates               map[string]*models.WorkflowTemplate       `json:"templates"`
	Executions              map[string]*models.Execution              `json:"executions"`
	ExecutionLogs           map[string][]models.ExecutionLog          `json:"executionLogs"`
	Timelines               map[string][]models.ExecutionStep         `json:"timelines"`
	Healing                 map[string]models.HealingReport           `json:"healing"`
	Chats                   map[string]*models.ChatSessionDetail      `json:"chats"`
	Settings                models.SettingsBundle                     `json:"settings"`
	Providers               map[string]*storedProvider                `json:"providers"`
	Integrations            map[string]*models.Integration            `json:"integrations"`
	Webhooks                map[string]*models.Webhook                `json:"webhooks"`
	AuditLogs               map[string]*models.AuditLog               `json:"auditLogs"`
	Notifications           map[string]*models.Notification           `json:"notifications"`
	NotificationPreferences map[string]models.NotificationPreferences `json:"notificationPreferences"`
	APIKeys                 map[string]*storedAPIKey                  `json:"apiKeys"`
	Uploads                 map[string]*models.UploadedFile           `json:"uploads"`
	UploadContents          map[string][]byte                         `json:"uploadContents"`
}

func marshalState(store *Store) ([]byte, error) {
	workflows := make(map[string]*storedWorkflow, len(store.Workflows))
	for id, workflow := range store.Workflows {
		if workflow == nil {
			workflows[id] = nil
			continue
		}
		workflows[id] = &storedWorkflow{
			Workflow: *workflow,
			YAML:     workflow.YAML,
			Canvas:   workflow.Canvas,
			Archived: workflow.Archived,
		}
	}
	providers := make(map[string]*storedProvider, len(store.Providers))
	for id, provider := range store.Providers {
		if provider == nil {
			providers[id] = nil
			continue
		}
		providers[id] = &storedProvider{ProviderConfig: *provider, APIKey: provider.APIKey}
	}
	apiKeys := make(map[string]*storedAPIKey, len(store.APIKeys))
	for id, apiKey := range store.APIKeys {
		if apiKey == nil {
			apiKeys[id] = nil
			continue
		}
		apiKeys[id] = &storedAPIKey{APIKey: *apiKey, Key: apiKey.Key}
	}

	state := persistedState{
		Version:                 persistedStateVersion,
		Counter:                 store.counter.Load(),
		Users:                   store.Users,
		PasswordHashes:          store.PasswordHashes,
		RefreshSessions:         store.RefreshSessions,
		Roles:                   store.Roles,
		Permissions:             store.Permissions,
		Workflows:               workflows,
		Versions:                store.Versions,
		Templates:               store.Templates,
		Executions:              store.Executions,
		ExecutionLogs:           store.ExecutionLogs,
		Timelines:               store.Timelines,
		Healing:                 store.Healing,
		Chats:                   store.Chats,
		Settings:                store.Settings,
		Providers:               providers,
		Integrations:            store.Integrations,
		Webhooks:                store.Webhooks,
		AuditLogs:               store.AuditLogs,
		Notifications:           store.Notifications,
		NotificationPreferences: store.NotificationPreferences,
		APIKeys:                 apiKeys,
		Uploads:                 store.Uploads,
		UploadContents:          store.UploadContents,
	}
	payload, err := json.Marshal(state)
	if err != nil {
		return nil, fmt.Errorf("serialize runtime state: %w", err)
	}
	return payload, nil
}

func restoreState(store *Store, payload []byte) error {
	var state persistedState
	if err := json.Unmarshal(payload, &state); err != nil {
		return fmt.Errorf("deserialize persisted runtime state: %w", err)
	}
	if state.Version != persistedStateVersion {
		return fmt.Errorf("unsupported persisted runtime state version %d", state.Version)
	}

	setMap(&store.Users, state.Users)
	setMap(&store.PasswordHashes, state.PasswordHashes)
	setMap(&store.RefreshSessions, state.RefreshSessions)
	setMap(&store.Roles, state.Roles)
	if state.Permissions != nil {
		store.Permissions = state.Permissions
	}
	if state.Workflows != nil {
		store.Workflows = make(map[string]*models.Workflow, len(state.Workflows))
		for id, stored := range state.Workflows {
			if stored == nil {
				store.Workflows[id] = nil
				continue
			}
			workflow := stored.Workflow
			workflow.YAML = stored.YAML
			workflow.Canvas = stored.Canvas
			workflow.Archived = stored.Archived
			store.Workflows[id] = &workflow
		}
	}
	setMap(&store.Versions, state.Versions)
	setMap(&store.Templates, state.Templates)
	setMap(&store.Executions, state.Executions)
	setMap(&store.ExecutionLogs, state.ExecutionLogs)
	setMap(&store.Timelines, state.Timelines)
	setMap(&store.Healing, state.Healing)
	setMap(&store.Chats, state.Chats)
	if state.Settings.General != nil || state.Settings.LLM != nil || state.Settings.RBAC != nil {
		store.Settings = state.Settings
	}
	if state.Providers != nil {
		store.Providers = make(map[string]*models.ProviderConfig, len(state.Providers))
		for id, stored := range state.Providers {
			if stored == nil {
				store.Providers[id] = nil
				continue
			}
			provider := stored.ProviderConfig
			provider.APIKey = stored.APIKey
			store.Providers[id] = &provider
		}
	}
	setMap(&store.Integrations, state.Integrations)
	setMap(&store.Webhooks, state.Webhooks)
	setMap(&store.AuditLogs, state.AuditLogs)
	setMap(&store.Notifications, state.Notifications)
	setMap(&store.NotificationPreferences, state.NotificationPreferences)
	if state.APIKeys != nil {
		store.APIKeys = make(map[string]*models.APIKey, len(state.APIKeys))
		for id, stored := range state.APIKeys {
			if stored == nil {
				store.APIKeys[id] = nil
				continue
			}
			apiKey := stored.APIKey
			apiKey.Key = stored.Key
			store.APIKeys[id] = &apiKey
		}
	}
	setMap(&store.Uploads, state.Uploads)
	setMap(&store.UploadContents, state.UploadContents)
	store.advanceCounterTo(state.Counter)
	normalizePersistedStateV1(store)
	return nil
}

func (s *Store) advanceCounterTo(minimum uint64) {
	for {
		current := s.counter.Load()
		if current >= minimum {
			return
		}
		if s.counter.CompareAndSwap(current, minimum) {
			return
		}
	}
}

// normalizePersistedStateV1 is the v1 envelope upgrader. Persisted business
// records remain authoritative, while policy definitions required by the
// running binary are added so an older snapshot cannot hide a newly introduced
// permission or built-in role. Existing roles other than the non-editable
// Platform Admin role are intentionally not merged: an explicit revocation
// must survive a restart.
func normalizePersistedStateV1(store *Store) {
	defaults := NewStore()
	existingPermissions := make(map[string]struct{}, len(store.Permissions))
	for _, permission := range store.Permissions {
		existingPermissions[permission.Key] = struct{}{}
	}
	for _, permission := range defaults.Permissions {
		if _, exists := existingPermissions[permission.Key]; exists {
			continue
		}
		store.Permissions = append(store.Permissions, permission)
		existingPermissions[permission.Key] = struct{}{}
	}
	if store.Roles == nil {
		store.Roles = map[string]*models.Role{}
	}
	for roleID, required := range defaults.Roles {
		existing := store.Roles[roleID]
		if existing == nil {
			roleCopy := *required
			roleCopy.Permissions = append([]string(nil), required.Permissions...)
			store.Roles[roleID] = &roleCopy
			continue
		}
		if roleID != RolePlatformAdminID {
			continue
		}
		seen := make(map[string]struct{}, len(existing.Permissions))
		for _, permission := range existing.Permissions {
			seen[permission] = struct{}{}
		}
		for _, permission := range required.Permissions {
			if _, exists := seen[permission]; exists {
				continue
			}
			existing.Permissions = append(existing.Permissions, permission)
			seen[permission] = struct{}{}
		}
	}
}

func setMap[K comparable, V any](target *map[K]V, value map[K]V) {
	if value != nil {
		*target = value
	}
}
