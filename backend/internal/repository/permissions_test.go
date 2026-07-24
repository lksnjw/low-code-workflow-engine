package repository

import (
	"testing"

	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

func TestDefaultRolesAreExactlyFour(t *testing.T) {
	store := NewStore()
	if len(store.Roles) != 4 {
		t.Fatalf("default role count=%d, want 4", len(store.Roles))
	}
	for _, roleID := range []string{RolePlatformAdminID, RoleSystemAdminID, RoleBuilderID, RoleClientID} {
		if store.Roles[roleID] == nil {
			t.Fatalf("missing built-in role %s", roleID)
		}
	}
}

func TestRoleEditPropagatesToExistingUsers(t *testing.T) {
	store := NewStore()
	store.Users["holder"] = &models.User{ID: "holder", RoleID: RoleBuilderID, PermissionOverrides: []string{}}

	before, ok := store.EffectiveUser("holder")
	if !ok || !containsString(before.Permissions, "workflow:write") {
		t.Fatalf("holder did not receive initial role permissions: %+v", before)
	}
	store.Mu.Lock()
	store.Roles[RoleBuilderID].Permissions = []string{"workflow:read"}
	store.Mu.Unlock()

	after, ok := store.EffectiveUser("holder")
	if !ok {
		t.Fatal("holder disappeared after role edit")
	}
	if len(after.Permissions) != 1 || after.Permissions[0] != "workflow:read" {
		t.Fatalf("existing holder retained stale permissions: %v", after.Permissions)
	}
}

func TestPermissionCacheInvalidatedOnRoleWrite(t *testing.T) {
	store := NewStore()
	store.Users["holder"] = &models.User{ID: "holder", RoleID: RoleBuilderID, PermissionOverrides: []string{"audit:read"}}

	first, _ := store.EffectiveUser("holder")
	store.Mu.Lock()
	store.Roles[RoleBuilderID].Permissions = []string{}
	store.Mu.Unlock()
	second, _ := store.EffectiveUser("holder")

	if containsString(second.Permissions, "workflow:write") {
		t.Fatalf("permission read returned a stale role value: before=%v after=%v", first.Permissions, second.Permissions)
	}
	if !containsString(second.Permissions, "audit:read") {
		t.Fatalf("additive override was lost after role write: %v", second.Permissions)
	}
}
