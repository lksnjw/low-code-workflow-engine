package repository

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/storage"
)

type testStateStore struct {
	mu      sync.Mutex
	payload []byte
	fail    bool
}

func (s *testStateStore) Load(context.Context) ([]byte, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.payload == nil {
		return nil, false, nil
	}
	return append([]byte(nil), s.payload...), true, nil
}

func (s *testStateStore) Save(_ context.Context, payload []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return errors.New("simulated persistence failure")
	}
	s.payload = append([]byte(nil), payload...)
	return nil
}

func (s *testStateStore) Probe(context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return errors.New("simulated persistence probe failure")
	}
	return nil
}

func (s *testStateStore) Close() {}

func (s *testStateStore) setFailure(fail bool) {
	s.mu.Lock()
	s.fail = fail
	s.mu.Unlock()
}

func TestPersistentStoreEncryptedRestartRoundTrip(t *testing.T) {
	backend := &testStateStore{}
	codec, err := storage.NewAESGCMCodec(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x51}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewPersistentStore(context.Background(), backend, codec, nil)
	if err != nil {
		t.Fatalf("NewPersistentStore: %v", err)
	}
	workflowID := store.NextID("workflow")
	now := time.Now().UTC().Truncate(time.Millisecond)
	store.Mu.Lock()
	store.Users["user_1"] = &models.User{
		ID: "user_1", Email: "client@example.test", Role: models.RoleRef{ID: "role_client", Name: "Client"},
		Permissions: []string{"workflow:read_own", "workflow:run_own"}, CreatedAt: now,
	}
	store.PasswordHashes["user_1"] = "password-hash"
	store.RefreshSessions["refresh-digest"] = RefreshSession{UserID: "user_1", ExpiresAt: now.Add(time.Hour)}
	store.Workflows[workflowID] = &models.Workflow{
		ID: workflowID, Name: "Durable workflow", YAML: "name: durable", Archived: true,
		AssignedUserIDs: []string{"user_1"},
		Canvas:          models.WorkflowCanvas{WorkflowID: workflowID, Nodes: []models.WorkflowNode{{ID: "node_1"}}},
	}
	completedAt := now.Add(time.Second)
	store.Executions["execution_1"] = &models.Execution{
		ID: "execution_1", WorkflowID: workflowID, Status: models.StatusDone, StartedAt: now,
		CompletedAt: &completedAt, StartedBy: models.Principal{ID: "user_1", Name: "Client"},
	}
	store.ExecutionLogs["execution_1"] = []models.ExecutionLog{{ID: "log_1", ExecutionID: "execution_1", Message: "completed", Timestamp: now}}
	store.Timelines["execution_1"] = []models.ExecutionStep{{ID: "step_1", NodeID: "node_1", Status: models.StatusDone, StartedAt: now}}
	store.Chats["chat_1"] = &models.ChatSessionDetail{
		ChatSession: models.ChatSession{ID: "chat_1", OwnerID: "user_1", Title: "Durable chat", CreatedAt: now, UpdatedAt: now, MessageCount: 1},
		Messages:    []models.ChatMessage{{ID: "message_1", Role: "user", Text: "hello", CreatedAt: now}},
	}
	store.Providers["provider_1"] = &models.ProviderConfig{ID: "provider_1", APIKey: "provider-secret", Active: true}
	store.Settings.LLM["apiKey"] = "settings-secret"
	store.APIKeys["key_1"] = &models.APIKey{ID: "key_1", Key: "application-secret"}
	store.UploadContents["upload_1"] = []byte("file bytes")
	store.Mu.Unlock()

	backend.mu.Lock()
	ciphertext := append([]byte(nil), backend.payload...)
	backend.mu.Unlock()
	for _, secret := range []string{"provider-secret", "settings-secret", "application-secret", "password-hash", "name: durable"} {
		if strings.Contains(string(ciphertext), secret) {
			t.Fatalf("persisted ciphertext leaked %q", secret)
		}
	}

	restored, err := NewPersistentStore(context.Background(), backend, codec, nil)
	if err != nil {
		t.Fatalf("restart NewPersistentStore: %v", err)
	}
	if restored.Users["user_1"].Email != "client@example.test" {
		t.Fatal("user was not restored")
	}
	if restored.PasswordHashes["user_1"] != "password-hash" || restored.RefreshSessions["refresh-digest"].UserID != "user_1" {
		t.Fatal("authentication credentials or refresh session were not restored")
	}
	workflow := restored.Workflows[workflowID]
	if workflow == nil || workflow.YAML != "name: durable" || !workflow.Archived || len(workflow.Canvas.Nodes) != 1 || len(workflow.AssignedUserIDs) != 1 {
		t.Fatalf("workflow private fields were not restored: %#v", workflow)
	}
	if restored.Executions["execution_1"].StartedBy.ID != "user_1" || len(restored.ExecutionLogs["execution_1"]) != 1 || len(restored.Timelines["execution_1"]) != 1 {
		t.Fatal("execution evidence was not restored")
	}
	if restored.Chats["chat_1"].OwnerID != "user_1" || len(restored.Chats["chat_1"].Messages) != 1 {
		t.Fatal("chat session was not restored")
	}
	if restored.Providers["provider_1"].APIKey != "provider-secret" {
		t.Fatal("provider credential was not restored")
	}
	if provider, ok := restored.ActiveProvider(); !ok || provider.ID != "provider_1" || provider.APIKey != "provider-secret" {
		t.Fatal("active provider resolution failed after restart")
	}
	if restored.Settings.LLM["apiKey"] != "settings-secret" || restored.APIKeys["key_1"].Key != "application-secret" {
		t.Fatal("secret settings were not restored")
	}
	if !bytes.Equal(restored.UploadContents["upload_1"], []byte("file bytes")) {
		t.Fatal("upload content was not restored")
	}
	if next := restored.NextID("workflow"); next != "workflow_2" {
		t.Fatalf("counter not restored safely: got %q", next)
	}
}

func TestPersistentStoreHealthTracksSaveFailureAndRecovery(t *testing.T) {
	backend := &testStateStore{}
	codec, err := storage.NewAESGCMCodec(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x71}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewPersistentStore(context.Background(), backend, codec, nil)
	if err != nil {
		t.Fatal(err)
	}
	if durable, healthy := store.PersistenceStatus(); !durable || !healthy {
		t.Fatalf("initial persistence status = durable %v healthy %v", durable, healthy)
	}

	backend.setFailure(true)
	beforeGeneration := store.PersistenceFailureGeneration()
	store.Mu.Lock()
	store.Settings.General["failure-test"] = true
	store.Mu.Unlock()
	if durable, healthy := store.PersistenceStatus(); !durable || healthy {
		t.Fatalf("failed persistence status = durable %v healthy %v", durable, healthy)
	}
	if _, exists := store.Settings.General["failure-test"]; exists {
		t.Fatal("failed mutation was not rolled back")
	}
	if got := store.PersistenceFailureGeneration(); got != beforeGeneration+1 {
		t.Fatalf("failure generation = %d, want %d", got, beforeGeneration+1)
	}

	backend.setFailure(false)
	if durable, healthy := store.ProbePersistence(context.Background()); !durable || !healthy {
		t.Fatalf("probe recovery status = durable %v healthy %v", durable, healthy)
	}
	store.Mu.Lock()
	store.Settings.General["recovery-test"] = true
	store.Mu.Unlock()
	if durable, healthy := store.PersistenceStatus(); !durable || !healthy {
		t.Fatalf("recovered persistence status = durable %v healthy %v", durable, healthy)
	}
}

func TestPersistentStoreNormalizesRequiredV1Policies(t *testing.T) {
	backend := &testStateStore{}
	codec, err := storage.NewAESGCMCodec(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x33}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	legacy := NewStore()
	delete(legacy.Roles, "role_client")
	delete(legacy.Roles, RoleSystemAdminID)
	legacy.Roles["role_admin"].Permissions = []string{"workflow:read"}
	legacy.Roles[RoleBuilderID].Permissions = []string{}
	legacy.Roles["role_custom"] = &models.Role{ID: "role_custom", Name: "Custom", Permissions: []string{"workflow:read"}}
	permissions := legacy.Permissions[:0]
	for _, permission := range legacy.Permissions {
		if permission.Key != "chat:use" {
			permissions = append(permissions, permission)
		}
	}
	legacy.Permissions = permissions
	plaintext, err := marshalState(legacy)
	if err != nil {
		t.Fatal(err)
	}
	backend.payload, err = codec.Encode(plaintext)
	if err != nil {
		t.Fatal(err)
	}

	restored, err := NewPersistentStore(context.Background(), backend, codec, nil)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Roles["role_client"] == nil {
		t.Fatal("required client role was not restored")
	}
	if restored.Roles[RoleSystemAdminID] == nil {
		t.Fatal("required system administrator role was not restored")
	}
	if restored.Roles["role_custom"] == nil {
		t.Fatal("custom role was lost during normalization")
	}
	if !containsString(restored.Roles["role_admin"].Permissions, "settings:manage") {
		t.Fatal("required administrator permissions were not merged")
	}
	if len(restored.Roles[RoleBuilderID].Permissions) != 0 {
		t.Fatalf("revoked builder permissions were restored: %v", restored.Roles[RoleBuilderID].Permissions)
	}
	foundChatPermission := false
	for _, permission := range restored.Permissions {
		if permission.Key == "chat:use" {
			foundChatPermission = true
			break
		}
	}
	if !foundChatPermission {
		t.Fatal("required permission definition was not merged")
	}
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
