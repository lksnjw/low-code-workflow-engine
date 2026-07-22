package handlers

import (
	"encoding/csv"
	"fmt"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"golang.org/x/crypto/bcrypt"
)

func (h *Handler) ListUsers(c *fiber.Ctx) error {
	page, limit := pageLimit(c)
	q := strings.ToLower(c.Query("q"))
	h.Store.Mu.RLock()
	users := make([]models.User, 0, len(h.Store.Users))
	for _, stored := range h.Store.Users {
		user := *stored
		if role := h.Store.Roles[stored.Role.ID]; role != nil {
			user.Role = models.RoleRef{ID: role.ID, Name: role.Name}
			user.Permissions = append([]string(nil), role.Permissions...)
		} else {
			user.Permissions = nil
		}
		users = append(users, user)
	}
	h.Store.Mu.RUnlock()
	filtered := []models.User{}
	for _, user := range users {
		if q != "" && !strings.Contains(strings.ToLower(user.Name+" "+user.Email), q) {
			continue
		}
		if role := c.Query("role"); role != "" && user.Role.ID != role && user.Role.Name != role {
			continue
		}
		if status := c.Query("status"); status != "" && user.Status != status {
			continue
		}
		filtered = append(filtered, user)
	}
	paged, meta := paginate(filtered, page, limit)
	return c.JSON(models.OK(paged, "OK", meta))
}

func (h *Handler) CreateUser(c *fiber.Ctx) error {
	body := decodeMap(c)
	name := strings.TrimSpace(fmt.Sprint(body["name"]))
	email := strings.ToLower(strings.TrimSpace(fmt.Sprint(body["email"])))
	password := fmt.Sprint(body["password"])
	if name == "" || name == "<nil>" || email == "" || email == "<nil>" || len(password) < 8 {
		return fiber.NewError(fiber.StatusBadRequest, "Name, email, and a password of at least 8 characters are required")
	}
	passwordHash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Could not secure password")
	}
	roleID := fmt.Sprint(body["roleId"])
	if roleID == "" || roleID == "<nil>" {
		roleID = repository.RoleBuilderID
	}
	actorUser := h.currentUser(c)
	actor := principalFromUser(actorUser)

	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	for _, existing := range h.Store.Users {
		if strings.EqualFold(existing.Email, email) {
			return c.Status(fiber.StatusConflict).JSON(models.Fail("An account with this email already exists", nil))
		}
	}
	role := h.Store.Roles[roleID]
	if role == nil {
		return fiber.NewError(fiber.StatusBadRequest, "Role not found")
	}
	if !canAssignRole(actorUser, role.ID) {
		return c.Status(fiber.StatusForbidden).JSON(models.Fail("Your role cannot assign the requested role", nil))
	}
	id := h.Store.NextID("usr")
	user := &models.User{ID: id, Name: name, Email: email, Role: models.RoleRef{ID: role.ID, Name: role.Name}, Permissions: append([]string{}, role.Permissions...), Status: "Active", Initials: initials(name), Timezone: "UTC", CreatedAt: time.Now().UTC(), EmailVerified: false}
	h.Store.Users[id] = user
	h.Store.PasswordHashes[id] = string(passwordHash)
	h.Store.Audit(actor, "user.created", models.ResourceRef{Type: "user", ID: id}, nil, map[string]interface{}{"email": email, "roleId": role.ID}, c.IP(), c.Get("User-Agent"))
	h.Store.Audit(actor, "user.role_assigned", models.ResourceRef{Type: "user", ID: id}, nil, map[string]interface{}{"roleId": role.ID, "source": "administration"}, c.IP(), c.Get("User-Agent"))
	return c.Status(fiber.StatusCreated).JSON(models.OK(user, "User created", nil))
}

func (h *Handler) GetUser(c *fiber.Ctx) error {
	user, ok := h.Store.EffectiveUser(c.Params("id"))
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "User not found")
	}
	return c.JSON(models.OK(user, "OK", nil))
}

func (h *Handler) UpdateUser(c *fiber.Ctx) error {
	body := decodeMap(c)
	actorUser := h.currentUser(c)
	if actorUser == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.Fail("Authenticated user no longer exists", nil))
	}
	actor := principalFromUser(actorUser)
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	user, ok := h.Store.Users[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "User not found")
	}
	requestedRoleID, roleProvided := requestString(body, "roleId")
	requestedStatus, statusProvided := requestString(body, "status")
	if statusProvided && !validUserStatus(requestedStatus) {
		return fiber.NewError(fiber.StatusBadRequest, "Status must be Active or Suspended")
	}
	if user.ID == actorUser.ID {
		if roleProvided && requestedRoleID != user.Role.ID {
			return c.Status(fiber.StatusConflict).JSON(models.Fail("You cannot change your own role", nil))
		}
		if statusProvided && !strings.EqualFold(requestedStatus, "active") {
			return c.Status(fiber.StatusConflict).JSON(models.Fail("You cannot deactivate your own account", nil))
		}
	}
	if protectedAdministratorAccount(user) && actorUser.Role.ID != repository.RolePlatformAdminID {
		return c.Status(fiber.StatusForbidden).JSON(models.Fail("Only a Platform Admin can modify administrator accounts", nil))
	}
	var requestedRole *models.Role
	if roleProvided {
		requestedRole = h.Store.Roles[requestedRoleID]
		if requestedRole == nil {
			return fiber.NewError(fiber.StatusBadRequest, "Role not found")
		}
		if requestedRole.ID != user.Role.ID && !canAssignRole(actorUser, requestedRole.ID) {
			return c.Status(fiber.StatusForbidden).JSON(models.Fail("Your role cannot assign the requested role", nil))
		}
	}
	if statusProvided && user.Role.ID == repository.RolePlatformAdminID && !strings.EqualFold(requestedStatus, "active") && countActiveUsersWithRoleLocked(h.Store, repository.RolePlatformAdminID) <= 1 {
		return c.Status(fiber.StatusConflict).JSON(models.Fail("The last active Platform Admin cannot be suspended", nil))
	}
	before := map[string]interface{}{"name": user.Name, "status": user.Status, "roleId": user.Role.ID}
	if name, provided := requestString(body, "name"); provided {
		user.Name = name
		user.Initials = initials(name)
	}
	if statusProvided {
		user.Status = requestedStatus
		if !strings.EqualFold(requestedStatus, "active") {
			revokeRefreshSessionsLocked(h.Store, user.ID)
		}
	}
	if requestedRole != nil {
		if requestedRole.ID != user.Role.ID {
			oldRoleID := user.Role.ID
			user.Role = models.RoleRef{ID: requestedRole.ID, Name: requestedRole.Name}
			user.Permissions = append([]string(nil), requestedRole.Permissions...)
			h.Store.Audit(actor, "user.role_assigned", models.ResourceRef{Type: "user", ID: user.ID}, map[string]interface{}{"roleId": oldRoleID}, map[string]interface{}{"roleId": requestedRole.ID, "source": "administration"}, c.IP(), c.Get("User-Agent"))
		}
	}
	h.Store.Audit(actor, "user.updated", models.ResourceRef{Type: "user", ID: user.ID}, before, map[string]interface{}{"name": user.Name, "status": user.Status, "roleId": user.Role.ID}, c.IP(), c.Get("User-Agent"))
	return c.JSON(models.OK(user, "User updated", nil))
}

func (h *Handler) DeleteUser(c *fiber.Ctx) error {
	actorUser := h.currentUser(c)
	if actorUser == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.Fail("Authenticated user no longer exists", nil))
	}
	if c.Params("id") == actorUser.ID {
		return c.Status(fiber.StatusConflict).JSON(models.Fail("You cannot delete your own active account", nil))
	}
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	userID := c.Params("id")
	user := h.Store.Users[userID]
	if user == nil {
		return fiber.NewError(fiber.StatusNotFound, "User not found")
	}
	if protectedAdministratorAccount(user) && actorUser.Role.ID != repository.RolePlatformAdminID {
		return c.Status(fiber.StatusForbidden).JSON(models.Fail("Only a Platform Admin can delete administrator accounts", nil))
	}
	if user.Role.ID == repository.RolePlatformAdminID && strings.EqualFold(user.Status, "active") && countActiveUsersWithRoleLocked(h.Store, repository.RolePlatformAdminID) <= 1 {
		return c.Status(fiber.StatusConflict).JSON(models.Fail("The last Platform Admin cannot be deleted", nil))
	}
	delete(h.Store.Users, userID)
	delete(h.Store.PasswordHashes, userID)
	revokeRefreshSessionsLocked(h.Store, userID)
	h.Store.Audit(principalFromUser(actorUser), "user.deleted", models.ResourceRef{Type: "user", ID: userID}, map[string]interface{}{"email": user.Email, "roleId": user.Role.ID}, nil, c.IP(), c.Get("User-Agent"))
	return c.JSON(models.OK(map[string]bool{"deleted": true}, "User deleted", nil))
}

func (h *Handler) InviteUser(c *fiber.Ctx) error {
	return featureNotConfigured(c, "Email invitations")
}

func (h *Handler) ActivateUser(c *fiber.Ctx) error {
	return h.setUserStatus(c, "Active")
}

func (h *Handler) SuspendUser(c *fiber.Ctx) error {
	return h.setUserStatus(c, "Suspended")
}

func (h *Handler) setUserStatus(c *fiber.Ctx, status string) error {
	actorUser := h.currentUser(c)
	if actorUser == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.Fail("Authenticated user no longer exists", nil))
	}
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	user, ok := h.Store.Users[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "User not found")
	}
	if protectedAdministratorAccount(user) && actorUser.Role.ID != repository.RolePlatformAdminID {
		return c.Status(fiber.StatusForbidden).JSON(models.Fail("Only a Platform Admin can change administrator accounts", nil))
	}
	if user.ID == actorUser.ID && !strings.EqualFold(status, "active") {
		return c.Status(fiber.StatusConflict).JSON(models.Fail("You cannot deactivate your own account", nil))
	}
	if user.Role.ID == repository.RolePlatformAdminID && !strings.EqualFold(status, "active") && countActiveUsersWithRoleLocked(h.Store, repository.RolePlatformAdminID) <= 1 {
		return c.Status(fiber.StatusConflict).JSON(models.Fail("The last active Platform Admin cannot be suspended", nil))
	}
	before := user.Status
	user.Status = status
	if !strings.EqualFold(status, "active") {
		revokeRefreshSessionsLocked(h.Store, user.ID)
	}
	h.Store.Audit(principalFromUser(actorUser), "user.status_changed", models.ResourceRef{Type: "user", ID: user.ID}, map[string]interface{}{"status": before}, map[string]interface{}{"status": status}, c.IP(), c.Get("User-Agent"))
	return c.JSON(models.OK(user, "User status updated", nil))
}

// revokeRefreshSessionsLocked removes every refresh session for a user. The
// caller must hold Store.Mu for writing so a suspension and revocation become
// visible atomically.
func revokeRefreshSessionsLocked(store *repository.Store, userID string) {
	for digest, session := range store.RefreshSessions {
		if session.UserID == userID {
			delete(store.RefreshSessions, digest)
		}
	}
}

func (h *Handler) ListRoles(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	roles := repository.ListMapValues(h.Store.Roles)
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(roles, "OK", nil))
}

func (h *Handler) CreateRole(c *fiber.Ctx) error {
	body := decodeMap(c)
	actorUser := h.currentUser(c)
	if !canManageRoles(actorUser) {
		return c.Status(fiber.StatusForbidden).JSON(models.Fail("Your role cannot manage roles", nil))
	}
	name := strings.TrimSpace(fmt.Sprint(body["name"]))
	if name == "" || name == "<nil>" {
		return fiber.NewError(fiber.StatusBadRequest, "Role name is required")
	}
	permissions := normalizeStringSlice(body["permissions"])
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	if err := validateRolePermissionsLocked(h.Store, permissions); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	if actorUser.Role.ID == repository.RoleSystemAdminID && containsAdministrativePermission(permissions) {
		return c.Status(fiber.StatusForbidden).JSON(models.Fail("Only a Platform Admin can grant administrative permissions", nil))
	}
	for _, existing := range h.Store.Roles {
		if strings.EqualFold(strings.TrimSpace(existing.Name), name) {
			return c.Status(fiber.StatusConflict).JSON(models.Fail("A role with this name already exists", nil))
		}
	}
	description, _ := requestString(body, "description")
	role := &models.Role{ID: "role_" + randomHex(4), Name: name, Description: description, Permissions: permissions, CreatedAt: time.Now().UTC()}
	h.Store.Roles[role.ID] = role
	h.Store.Audit(principalFromUser(actorUser), "role.created", models.ResourceRef{Type: "role", ID: role.ID}, nil, roleAuditState(role), c.IP(), c.Get("User-Agent"))
	return c.Status(fiber.StatusCreated).JSON(models.OK(role, "Role created", nil))
}

func (h *Handler) GetRole(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	role, ok := h.Store.Roles[c.Params("id")]
	h.Store.Mu.RUnlock()
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Role not found")
	}
	return c.JSON(models.OK(role, "OK", nil))
}

func (h *Handler) UpdateRole(c *fiber.Ctx) error {
	body := decodeMap(c)
	actorUser := h.currentUser(c)
	if !canManageRoles(actorUser) {
		return c.Status(fiber.StatusForbidden).JSON(models.Fail("Your role cannot manage roles", nil))
	}
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	role, ok := h.Store.Roles[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Role not found")
	}
	if role.ID == repository.RolePlatformAdminID {
		return c.Status(fiber.StatusConflict).JSON(models.Fail("The Platform Admin role is protected", nil))
	}
	if role.ID == repository.RoleSystemAdminID && actorUser.Role.ID != repository.RolePlatformAdminID {
		return c.Status(fiber.StatusForbidden).JSON(models.Fail("Only a Platform Admin can modify the System Admin role", nil))
	}
	newName := role.Name
	if name, provided := requestString(body, "name"); provided {
		newName = name
		for id, existing := range h.Store.Roles {
			if id != role.ID && strings.EqualFold(strings.TrimSpace(existing.Name), newName) {
				return c.Status(fiber.StatusConflict).JSON(models.Fail("A role with this name already exists", nil))
			}
		}
	}
	newPermissions := append([]string(nil), role.Permissions...)
	if rawPermissions, provided := body["permissions"]; provided {
		permissions := normalizeStringSlice(rawPermissions)
		if err := validateRolePermissionsLocked(h.Store, permissions); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, err.Error())
		}
		if actorUser.Role.ID == repository.RoleSystemAdminID && containsAdministrativePermission(permissions) {
			return c.Status(fiber.StatusForbidden).JSON(models.Fail("Only a Platform Admin can grant administrative permissions", nil))
		}
		newPermissions = permissions
	}
	before := roleAuditState(role)
	role.Name = newName
	role.Permissions = newPermissions
	for _, user := range h.Store.Users {
		if user.Role.ID == role.ID {
			user.Role.Name = role.Name
			user.Permissions = append([]string(nil), role.Permissions...)
		}
	}
	h.Store.Audit(principalFromUser(actorUser), "role.updated", models.ResourceRef{Type: "role", ID: role.ID}, before, roleAuditState(role), c.IP(), c.Get("User-Agent"))
	return c.JSON(models.OK(role, "Role updated", nil))
}

func (h *Handler) DeleteRole(c *fiber.Ctx) error {
	actorUser := h.currentUser(c)
	if !canManageRoles(actorUser) {
		return c.Status(fiber.StatusForbidden).JSON(models.Fail("Your role cannot manage roles", nil))
	}
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	roleID := c.Params("id")
	role := h.Store.Roles[roleID]
	if role == nil {
		return fiber.NewError(fiber.StatusNotFound, "Role not found")
	}
	if protectedRoleID(roleID) {
		return c.Status(fiber.StatusConflict).JSON(models.Fail("Built-in roles cannot be deleted", nil))
	}
	for _, user := range h.Store.Users {
		if user.Role.ID == roleID {
			return c.Status(fiber.StatusConflict).JSON(models.Fail("Role is assigned to one or more users", nil))
		}
	}
	before := roleAuditState(role)
	delete(h.Store.Roles, roleID)
	h.Store.Audit(principalFromUser(actorUser), "role.deleted", models.ResourceRef{Type: "role", ID: roleID}, before, nil, c.IP(), c.Get("User-Agent"))
	return c.JSON(models.OK(map[string]bool{"deleted": true}, "Role deleted", nil))
}

func (h *Handler) ListPermissions(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	permissions := append([]models.Permission{}, h.Store.Permissions...)
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(permissions, "OK", nil))
}

func (h *Handler) PermissionMatrix(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	roles := repository.ListMapValues(h.Store.Roles)
	perms := append([]models.Permission{}, h.Store.Permissions...)
	h.Store.Mu.RUnlock()
	matrix := []map[string]interface{}{}
	for _, role := range roles {
		row := map[string]bool{}
		for _, permission := range perms {
			row[permission.Key] = containsString(role.Permissions, permission.Key)
		}
		matrix = append(matrix, map[string]interface{}{"role": role.Name, "permissions": row})
	}
	return c.JSON(models.OK(matrix, "OK", nil))
}

func (h *Handler) ListAudit(c *fiber.Ctx) error {
	page, limit := pageLimit(c)
	h.Store.Mu.RLock()
	logs := repository.ListMapValues(h.Store.AuditLogs)
	h.Store.Mu.RUnlock()
	paged, meta := paginate(logs, page, limit)
	return c.JSON(models.OK(paged, "OK", meta))
}

func (h *Handler) GetAudit(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	log, ok := h.Store.AuditLogs[c.Params("id")]
	h.Store.Mu.RUnlock()
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Audit log not found")
	}
	return c.JSON(models.OK(log, "OK", nil))
}

func (h *Handler) ExportAudit(c *fiber.Ctx) error {
	if c.Query("format", "json") == "csv" {
		c.Set("Content-Type", "text/csv")
		c.Set("Content-Disposition", "attachment; filename=audit.csv")
		writer := csv.NewWriter(c.Response().BodyWriter())
		_ = writer.Write([]string{"id", "actor", "action", "resource_type", "resource_id", "created_at"})
		h.Store.Mu.RLock()
		for _, log := range h.Store.AuditLogs {
			_ = writer.Write([]string{log.ID, log.Actor.Name, log.Action, log.Resource.Type, log.Resource.ID, log.CreatedAt.Format(time.RFC3339)})
		}
		h.Store.Mu.RUnlock()
		writer.Flush()
		return nil
	}
	return h.ListAudit(c)
}

func containsString(items []string, target string) bool {
	for _, item := range items {
		if item == target {
			return true
		}
	}
	return false
}

func requestString(body map[string]interface{}, key string) (string, bool) {
	raw, exists := body[key]
	if !exists || raw == nil {
		return "", false
	}
	value := strings.TrimSpace(fmt.Sprint(raw))
	if value == "" || value == "<nil>" {
		return "", false
	}
	return value, true
}

func canAssignRole(actor *models.User, roleID string) bool {
	if actor == nil {
		return false
	}
	switch actor.Role.ID {
	case repository.RolePlatformAdminID:
		return true
	case repository.RoleSystemAdminID:
		return roleID == repository.RoleBuilderID || roleID == repository.RoleClientID
	default:
		return false
	}
}

func canManageRoles(actor *models.User) bool {
	return actor != nil && (actor.Role.ID == repository.RolePlatformAdminID || actor.Role.ID == repository.RoleSystemAdminID)
}

func normalizeStringSlice(value interface{}) []string {
	items := parseStringSlice(value)
	out := make([]string, 0, len(items))
	seen := map[string]struct{}{}
	for _, item := range items {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if _, exists := seen[item]; exists {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	return out
}

func validateRolePermissionsLocked(store *repository.Store, permissions []string) error {
	known := make(map[string]struct{}, len(store.Permissions))
	for _, permission := range store.Permissions {
		known[permission.Key] = struct{}{}
	}
	for _, permission := range permissions {
		if _, exists := known[permission]; !exists {
			return fmt.Errorf("unknown permission %q", permission)
		}
	}
	return nil
}

func containsAdministrativePermission(permissions []string) bool {
	return containsString(permissions, "user:manage") || containsString(permissions, "settings:manage")
}

func protectedRoleID(roleID string) bool {
	switch roleID {
	case repository.RolePlatformAdminID, repository.RoleSystemAdminID, repository.RoleBuilderID, repository.RoleClientID:
		return true
	default:
		return false
	}
}

func protectedAdministratorAccount(user *models.User) bool {
	if user == nil {
		return false
	}
	return user.Role.ID == repository.RolePlatformAdminID || user.Role.ID == repository.RoleSystemAdminID
}

func validUserStatus(status string) bool {
	return strings.EqualFold(status, "active") || strings.EqualFold(status, "suspended")
}

func countActiveUsersWithRoleLocked(store *repository.Store, roleID string) int {
	count := 0
	for _, user := range store.Users {
		if user.Role.ID == roleID && strings.EqualFold(user.Status, "active") {
			count++
		}
	}
	return count
}

func roleAuditState(role *models.Role) map[string]interface{} {
	if role == nil {
		return nil
	}
	return map[string]interface{}{
		"name":        role.Name,
		"description": role.Description,
		"permissions": append([]string(nil), role.Permissions...),
	}
}
