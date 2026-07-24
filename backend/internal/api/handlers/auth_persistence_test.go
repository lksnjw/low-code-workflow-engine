package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares"
	"github.com/sanjeewa/agentic-orchestrator/internal/config"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/internal/storage"
)

type registrationFailStore struct {
	payload  []byte
	failNext bool
}

func (s *registrationFailStore) Load(context.Context) ([]byte, bool, error) {
	if s.payload == nil {
		return nil, false, nil
	}
	return append([]byte(nil), s.payload...), true, nil
}

func (s *registrationFailStore) Save(_ context.Context, payload []byte) error {
	if s.failNext {
		s.failNext = false
		return errors.New("simulated registration persistence failure")
	}
	s.payload = append([]byte(nil), payload...)
	return nil
}

func (s *registrationFailStore) Probe(context.Context) error { return nil }
func (s *registrationFailStore) Close()                      {}

func TestRegistrationPersistenceFailureRollsBackWholeAccount(t *testing.T) {
	backend := &registrationFailStore{}
	codec, err := storage.NewAESGCMCodec(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x63}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	store, err := repository.NewPersistentStore(context.Background(), backend, codec, nil)
	if err != nil {
		t.Fatal(err)
	}
	if created, bootstrapErr := store.BootstrapPlatformAdmin("admin@example.test", "admin-password"); bootstrapErr != nil || !created {
		t.Fatalf("bootstrap administrator: created=%t err=%v", created, bootstrapErr)
	}
	initialUsers := len(store.Users)
	initialHashes := len(store.PasswordHashes)
	initialAudits := len(store.AuditLogs)
	backend.failNext = true
	handler := &Handler{
		Cfg: config.Config{
			JWTSecret:               "test-registration-jwt-secret",
			TokenTTL:                time.Hour,
			AllowPublicRegistration: true,
		},
		Store: store,
	}
	app := fiber.New()
	app.Use(middlewares.PersistenceFailureGuard(store))
	app.Post("/register", handler.Register)

	response := registrationRequest(t, app, "rollback@example.test")
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusServiceUnavailable {
		t.Fatalf("status=%d, want %d", response.StatusCode, fiber.StatusServiceUnavailable)
	}
	if len(store.Users) != initialUsers || len(store.PasswordHashes) != initialHashes || len(store.RefreshSessions) != 0 || len(store.AuditLogs) != initialAudits {
		t.Fatalf("partial registration survived rollback: users=%d hashes=%d sessions=%d audits=%d", len(store.Users), len(store.PasswordHashes), len(store.RefreshSessions), len(store.AuditLogs))
	}
}
