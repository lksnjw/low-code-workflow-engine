package repository

import (
	"fmt"
	"strings"
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/authn"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

// BootstrapPlatformAdmin creates the sole first-run account. Existing users
// make the operation a no-op, so credentials are required only for an empty
// store and repeated startup is idempotent.
func (s *Store) BootstrapPlatformAdmin(email, password string) (bool, error) {
	if s == nil {
		return false, fmt.Errorf("bootstrap requires a user store")
	}

	failureGeneration := s.PersistenceFailureGeneration()
	s.Mu.Lock()
	if len(s.Users) > 0 {
		s.Mu.Unlock()
		return false, nil
	}

	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" || strings.TrimSpace(password) == "" {
		s.Mu.Unlock()
		return false, fmt.Errorf("empty user store requires BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD")
	}
	if len(password) < 8 {
		s.Mu.Unlock()
		return false, fmt.Errorf("BOOTSTRAP_ADMIN_PASSWORD must contain at least 8 characters")
	}
	role := s.Roles[RolePlatformAdminID]
	if role == nil {
		s.Mu.Unlock()
		return false, fmt.Errorf("platform_admin role is not configured")
	}
	passwordHash, err := authn.HashPassword(password)
	if err != nil {
		s.Mu.Unlock()
		return false, fmt.Errorf("hash bootstrap administrator password: %w", err)
	}

	now := time.Now().UTC()
	id := s.NextID("usr")
	user := &models.User{
		ID:                  id,
		Name:                "Platform Admin",
		Email:               email,
		RoleID:              role.ID,
		PermissionOverrides: []string{},
		Status:              "Active",
		Initials:            "PA",
		Timezone:            "UTC",
		CreatedAt:           now,
		EmailVerified:       true,
	}
	s.Users[id] = user
	s.PasswordHashes[id] = passwordHash
	s.Audit(
		models.Principal{ID: "system", Name: "System"},
		"user.bootstrapped",
		models.ResourceRef{Type: "user", ID: id},
		nil,
		map[string]interface{}{"email": email, "roleId": role.ID},
		"",
		"",
	)
	s.Mu.Unlock()
	if s.PersistenceFailureGeneration() != failureGeneration {
		return false, fmt.Errorf("persist bootstrap administrator")
	}
	return true, nil
}
