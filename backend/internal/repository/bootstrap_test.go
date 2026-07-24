package repository

import (
	"os"
	"strings"
	"testing"

	"github.com/sanjeewa/agentic-orchestrator/internal/authn"
)

func TestBootstrapIsIdempotentAndRefusesWithoutEnv(t *testing.T) {
	t.Setenv("BOOTSTRAP_ADMIN_EMAIL", "")
	t.Setenv("BOOTSTRAP_ADMIN_PASSWORD", "")
	store := NewStore()

	created, err := store.BootstrapPlatformAdmin(
		os.Getenv("BOOTSTRAP_ADMIN_EMAIL"),
		os.Getenv("BOOTSTRAP_ADMIN_PASSWORD"),
	)
	if err == nil || !strings.Contains(err.Error(), "BOOTSTRAP_ADMIN_EMAIL") || created {
		t.Fatalf("empty bootstrap result: created=%t err=%v", created, err)
	}
	if len(store.Users) != 0 {
		t.Fatal("failed bootstrap created a partial user")
	}

	t.Setenv("BOOTSTRAP_ADMIN_EMAIL", "ADMIN@example.test")
	t.Setenv("BOOTSTRAP_ADMIN_PASSWORD", "correct-horse-battery-staple")
	created, err = store.BootstrapPlatformAdmin(
		os.Getenv("BOOTSTRAP_ADMIN_EMAIL"),
		os.Getenv("BOOTSTRAP_ADMIN_PASSWORD"),
	)
	if err != nil || !created {
		t.Fatalf("valid bootstrap result: created=%t err=%v", created, err)
	}
	if len(store.Users) != 1 {
		t.Fatalf("bootstrap user count=%d, want 1", len(store.Users))
	}
	var userID string
	for id, user := range store.Users {
		userID = id
		if user.Email != "admin@example.test" || user.RoleID != RolePlatformAdminID {
			t.Fatalf("unexpected bootstrap user: %+v", user)
		}
	}
	if !authn.VerifyPassword(store.PasswordHashes[userID], "correct-horse-battery-staple") {
		t.Fatal("bootstrap password did not use the shared bcrypt path")
	}

	created, err = store.BootstrapPlatformAdmin("", "")
	if err != nil || created {
		t.Fatalf("repeat bootstrap result: created=%t err=%v", created, err)
	}
	if len(store.Users) != 1 {
		t.Fatalf("repeat bootstrap changed user count to %d", len(store.Users))
	}
}
