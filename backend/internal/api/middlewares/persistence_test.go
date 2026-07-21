package middlewares

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/internal/storage"
)

type guardStateStore struct {
	mu        sync.Mutex
	payload   []byte
	fail      bool
	failNext  bool
	failDelay time.Duration
}

func (s *guardStateStore) Load(context.Context) ([]byte, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.payload == nil {
		return nil, false, nil
	}
	return append([]byte(nil), s.payload...), true, nil
}

func (s *guardStateStore) Save(_ context.Context, payload []byte) error {
	s.mu.Lock()
	shouldFail := s.fail || s.failNext
	if s.failNext {
		s.failNext = false
	}
	delay := s.failDelay
	if shouldFail {
		s.mu.Unlock()
		if delay > 0 {
			time.Sleep(delay)
		}
		return errors.New("simulated save failure")
	}
	s.payload = append([]byte(nil), payload...)
	s.mu.Unlock()
	return nil
}

func (s *guardStateStore) Probe(context.Context) error { return nil }
func (s *guardStateStore) Close()                      {}

func TestPersistenceFailureGuardReturns503AfterRollback(t *testing.T) {
	backend := &guardStateStore{}
	codec, err := storage.NewAESGCMCodec(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x61}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	store, err := repository.NewPersistentStore(context.Background(), backend, codec, nil)
	if err != nil {
		t.Fatal(err)
	}
	backend.mu.Lock()
	backend.fail = true
	backend.mu.Unlock()

	app := fiber.New()
	app.Use(PersistenceFailureGuard(store))
	app.Post("/mutate", func(c *fiber.Ctx) error {
		store.Mu.Lock()
		store.Settings.General["should-rollback"] = true
		store.Mu.Unlock()
		return c.JSON(map[string]bool{"success": true})
	})

	response, err := app.Test(httptest.NewRequest(fiber.MethodPost, "/mutate", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusServiceUnavailable {
		t.Fatalf("status=%d, want %d", response.StatusCode, fiber.StatusServiceUnavailable)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "no mutation was committed") {
		t.Fatalf("response body=%s", body)
	}
	if _, exists := store.Settings.General["should-rollback"]; exists {
		t.Fatal("failed mutation remained in memory")
	}
}

func TestPersistenceFailureGuardAttributesConcurrentMutationFailure(t *testing.T) {
	backend := &guardStateStore{}
	codec, err := storage.NewAESGCMCodec(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x62}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	store, err := repository.NewPersistentStore(context.Background(), backend, codec, nil)
	if err != nil {
		t.Fatal(err)
	}
	backend.mu.Lock()
	backend.failNext = true
	backend.failDelay = 50 * time.Millisecond
	backend.mu.Unlock()

	enteredFirst := make(chan struct{})
	app := fiber.New()
	app.Use(PersistenceFailureGuard(store))
	app.Post("/:name", func(c *fiber.Ctx) error {
		name := c.Params("name")
		if name == "first" {
			close(enteredFirst)
		}
		store.Mu.Lock()
		store.Settings.General[name] = true
		store.Mu.Unlock()
		return c.JSON(map[string]bool{"success": true})
	})

	type result struct {
		status int
		err    error
	}
	firstResult := make(chan result, 1)
	go func() {
		response, requestErr := app.Test(httptest.NewRequest(fiber.MethodPost, "/first", nil))
		if requestErr != nil {
			firstResult <- result{err: requestErr}
			return
		}
		defer response.Body.Close()
		firstResult <- result{status: response.StatusCode}
	}()
	<-enteredFirst
	secondResponse, err := app.Test(httptest.NewRequest(fiber.MethodPost, "/second", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer secondResponse.Body.Close()
	first := <-firstResult
	if first.err != nil {
		t.Fatal(first.err)
	}
	if first.status != fiber.StatusServiceUnavailable {
		t.Fatalf("first status=%d, want %d", first.status, fiber.StatusServiceUnavailable)
	}
	if secondResponse.StatusCode != fiber.StatusOK {
		t.Fatalf("second status=%d, want %d", secondResponse.StatusCode, fiber.StatusOK)
	}
	if _, exists := store.Settings.General["first"]; exists {
		t.Fatal("failed first mutation remained in memory")
	}
	if store.Settings.General["second"] != true {
		t.Fatal("successful second mutation was not committed")
	}
}
