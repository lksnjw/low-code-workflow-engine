package repository

import (
	"fmt"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

const (
	RolePlatformAdminID = "role_admin"
	RoleSystemAdminID   = "role_system_admin"
	RoleBuilderID       = "role_builder"
	RoleClientID        = "role_client"
)

// RefreshSession is the server-side record behind an opaque refresh token.
// Only a SHA-256 digest of the token is used as the map key.
type RefreshSession struct {
	UserID    string
	ExpiresAt time.Time
}

// Store is the process-local runtime store. It deliberately starts without
// demo business records; records are created only through application APIs.
type Store struct {
	Mu StoreMutex

	counter atomic.Uint64
	persist *persistenceHook

	Users                   map[string]*models.User
	PasswordHashes          map[string]string
	RefreshSessions         map[string]RefreshSession
	Roles                   map[string]*models.Role
	Permissions             []models.Permission
	Workflows               map[string]*models.Workflow
	Versions                map[string][]models.WorkflowVersion
	Templates               map[string]*models.WorkflowTemplate
	Executions              map[string]*models.Execution
	ExecutionLogs           map[string][]models.ExecutionLog
	Timelines               map[string][]models.ExecutionStep
	Healing                 map[string]models.HealingReport
	Chats                   map[string]*models.ChatSessionDetail
	Settings                models.SettingsBundle
	Providers               map[string]*models.ProviderConfig
	Integrations            map[string]*models.Integration
	Webhooks                map[string]*models.Webhook
	AuditLogs               map[string]*models.AuditLog
	Notifications           map[string]*models.Notification
	NotificationPreferences map[string]models.NotificationPreferences
	APIKeys                 map[string]*models.APIKey
	Uploads                 map[string]*models.UploadedFile
	UploadContents          map[string][]byte
}

func NewStore() *Store {
	now := time.Now().UTC()
	permissions := []models.Permission{
		{Key: "workflow:read", Name: "Read workflows", Description: "View workflows, executions, analytics, and catalogs", Group: "Workflow"},
		{Key: "workflow:write", Name: "Write workflows", Description: "Create, edit, publish, archive, and import workflows", Group: "Workflow"},
		{Key: "workflow:run", Name: "Run workflows", Description: "Start, cancel, and retry workflow executions", Group: "Execution"},
		{Key: "chat:use", Name: "Use chat", Description: "Use owned synthesis chat sessions", Group: "Workflow"},
		{Key: "workflow:read_own", Name: "Read assigned workflows", Description: "View workflows owned by or assigned to the current user", Group: "Workflow"},
		{Key: "workflow:run_own", Name: "Run assigned workflows", Description: "Run workflows owned by or assigned to the current user", Group: "Execution"},
		{Key: "execution:read_own", Name: "Read own executions", Description: "View executions started by the current user", Group: "Execution"},
		{Key: "settings:manage", Name: "Manage settings", Description: "Manage runtime settings, integrations, webhooks, and API keys", Group: "Administration"},
		{Key: "user:manage", Name: "Manage users", Description: "Manage users, roles, and invitations", Group: "Administration"},
		{Key: "audit:read", Name: "Read audit logs", Description: "View and export governance audit records", Group: "Governance"},
	}
	allPermissions := permissionKeys(permissions)

	store := &Store{
		Users:           map[string]*models.User{},
		PasswordHashes:  map[string]string{},
		RefreshSessions: map[string]RefreshSession{},
		Roles:           map[string]*models.Role{},
		Permissions:     permissions,
		Workflows:       map[string]*models.Workflow{},
		Versions:        map[string][]models.WorkflowVersion{},
		Templates:       map[string]*models.WorkflowTemplate{},
		Executions:      map[string]*models.Execution{},
		ExecutionLogs:   map[string][]models.ExecutionLog{},
		Timelines:       map[string][]models.ExecutionStep{},
		Healing:         map[string]models.HealingReport{},
		Chats:           map[string]*models.ChatSessionDetail{},
		Settings: models.SettingsBundle{
			General: map[string]interface{}{},
			LLM:     map[string]interface{}{},
			RBAC:    map[string]interface{}{},
		},
		Integrations:            map[string]*models.Integration{},
		Providers:               map[string]*models.ProviderConfig{},
		Webhooks:                map[string]*models.Webhook{},
		AuditLogs:               map[string]*models.AuditLog{},
		Notifications:           map[string]*models.Notification{},
		NotificationPreferences: map[string]models.NotificationPreferences{},
		APIKeys:                 map[string]*models.APIKey{},
		Uploads:                 map[string]*models.UploadedFile{},
		UploadContents:          map[string][]byte{},
	}

	// These are authorization policy definitions, not sample application data.
	store.Roles[RolePlatformAdminID] = &models.Role{
		ID: RolePlatformAdminID, Name: "Platform Admin", Description: "Full platform administrator",
		Permissions: allPermissions, CreatedAt: now,
	}
	store.Roles[RoleSystemAdminID] = &models.Role{
		ID: RoleSystemAdminID, Name: "System Admin", Description: "Manages users, roles, settings, registries, and audit evidence without Platform Admin authority",
		Permissions: []string{"user:manage", "settings:manage", "audit:read"}, CreatedAt: now,
	}
	store.Roles[RoleBuilderID] = &models.Role{
		ID: RoleBuilderID, Name: "Workflow Builder", Description: "Creates, validates, and runs workflows",
		Permissions: []string{"workflow:read", "workflow:write", "workflow:run"}, CreatedAt: now,
	}
	store.Roles["role_reviewer"] = &models.Role{
		ID: "role_reviewer", Name: "Execution Reviewer", Description: "Reviews workflows and execution evidence",
		Permissions: []string{"workflow:read", "workflow:run", "audit:read"}, CreatedAt: now,
	}
	store.Roles["role_auditor"] = &models.Role{
		ID: "role_auditor", Name: "Auditor", Description: "Reads workflow and audit evidence",
		Permissions: []string{"workflow:read", "audit:read"}, CreatedAt: now,
	}
	store.Roles[RoleClientID] = &models.Role{
		ID: RoleClientID, Name: "Client", Description: "Uses assigned workflows and views owned execution evidence",
		Permissions: []string{"chat:use", "workflow:read_own", "workflow:run_own", "execution:read_own"}, CreatedAt: now,
	}

	return store
}

// EffectiveUser returns an immutable request-time snapshot whose role name and
// permissions come from the current role definition. The denormalized fields on
// older user records are never trusted for authorization.
func (s *Store) EffectiveUser(userID string) (*models.User, bool) {
	if s == nil {
		return nil, false
	}
	s.Mu.RLock()
	defer s.Mu.RUnlock()
	user := s.Users[userID]
	if user == nil {
		return nil, false
	}
	copyUser := *user
	if role := s.Roles[user.Role.ID]; role != nil {
		copyUser.Role = models.RoleRef{ID: role.ID, Name: role.Name}
		copyUser.Permissions = append([]string(nil), role.Permissions...)
	} else {
		// A missing role fails closed instead of retaining a stale permission copy.
		copyUser.Permissions = nil
	}
	return &copyUser, true
}

func (s *Store) ActiveProvider() (models.ProviderConfig, bool) {
	s.Mu.RLock()
	defer s.Mu.RUnlock()
	for _, provider := range s.Providers {
		if provider.Active {
			return *provider, true
		}
	}
	return models.ProviderConfig{}, false
}

func permissionKeys(permissions []models.Permission) []string {
	keys := make([]string, 0, len(permissions))
	for _, permission := range permissions {
		keys = append(keys, permission.Key)
	}
	return keys
}

// ApplyDevUserRole changes the builder role name used for local policy
// simulation. It never creates or mutates a synthetic user.
func ApplyDevUserRole(store *Store, roleName string) {
	roleName = strings.TrimSpace(roleName)
	if store == nil || roleName == "" {
		return
	}

	store.Mu.Lock()
	defer store.Mu.Unlock()
	if role := store.Roles[RoleBuilderID]; role != nil {
		role.Name = roleName
	}
}

func (s *Store) NextID(prefix string) string {
	value := s.counter.Add(1)
	return fmt.Sprintf("%s_%d", prefix, value)
}

// Audit expects the caller to hold Store.Mu when the operation being audited
// and the audit record must be committed atomically.
func (s *Store) Audit(actor models.Principal, action string, resource models.ResourceRef, before, after map[string]interface{}, ip, ua string) {
	id := s.NextID("audit")
	s.AuditLogs[id] = &models.AuditLog{
		ID: id, Actor: actor, Action: action, Resource: resource, IPAddress: ip, UserAgent: ua,
		Before: before, After: after, CreatedAt: time.Now().UTC(),
	}
}

func ListMapValues[T any](items map[string]*T) []T {
	out := make([]T, 0, len(items))
	for _, item := range items {
		out = append(out, *item)
	}
	return out
}

func SortWorkflows(items []models.Workflow) {
	sort.Slice(items, func(i, j int) bool {
		return items[i].UpdatedAt.After(items[j].UpdatedAt)
	})
}

func FilterWorkflows(items []models.Workflow, q, status string) []models.Workflow {
	q = strings.ToLower(strings.TrimSpace(q))
	status = strings.TrimSpace(status)
	out := make([]models.Workflow, 0, len(items))
	for _, item := range items {
		if status != "" && item.Status != status {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(item.Name+" "+item.Description), q) {
			continue
		}
		out = append(out, item)
	}
	return out
}
