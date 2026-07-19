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
	users := repository.ListMapValues(h.Store.Users)
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
		roleID = "role_builder"
	}
	actor := principalFromUser(h.currentUser(c))

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
	id := h.Store.NextID("usr")
	user := &models.User{ID: id, Name: name, Email: email, Role: models.RoleRef{ID: role.ID, Name: role.Name}, Permissions: append([]string{}, role.Permissions...), Status: "Active", Initials: initials(name), Timezone: "UTC", CreatedAt: time.Now().UTC(), EmailVerified: false}
	h.Store.Users[id] = user
	h.Store.PasswordHashes[id] = string(passwordHash)
	h.Store.Audit(actor, "user.created", models.ResourceRef{Type: "user", ID: id}, nil, map[string]interface{}{"email": email, "roleId": role.ID}, c.IP(), c.Get("User-Agent"))
	return c.Status(fiber.StatusCreated).JSON(models.OK(user, "User created", nil))
}

func (h *Handler) GetUser(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	user, ok := h.Store.Users[c.Params("id")]
	h.Store.Mu.RUnlock()
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "User not found")
	}
	return c.JSON(models.OK(user, "OK", nil))
}

func (h *Handler) UpdateUser(c *fiber.Ctx) error {
	body := decodeMap(c)
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	user, ok := h.Store.Users[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "User not found")
	}
	if name := fmt.Sprint(body["name"]); name != "" && name != "<nil>" {
		user.Name = name
		user.Initials = initials(name)
	}
	if status := fmt.Sprint(body["status"]); status != "" && status != "<nil>" {
		user.Status = status
	}
	if roleID := fmt.Sprint(body["roleId"]); roleID != "" && roleID != "<nil>" {
		if role := h.Store.Roles[roleID]; role != nil {
			user.Role = models.RoleRef{ID: role.ID, Name: role.Name}
			user.Permissions = role.Permissions
		}
	}
	return c.JSON(models.OK(user, "User updated", nil))
}

func (h *Handler) DeleteUser(c *fiber.Ctx) error {
	if c.Params("id") == h.currentUserID(c) {
		return c.Status(fiber.StatusConflict).JSON(models.Fail("You cannot delete your own active account", nil))
	}
	h.Store.Mu.Lock()
	userID := c.Params("id")
	delete(h.Store.Users, userID)
	delete(h.Store.PasswordHashes, userID)
	for digest, session := range h.Store.RefreshSessions {
		if session.UserID == userID {
			delete(h.Store.RefreshSessions, digest)
		}
	}
	h.Store.Mu.Unlock()
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
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	user, ok := h.Store.Users[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "User not found")
	}
	user.Status = status
	return c.JSON(models.OK(user, "User status updated", nil))
}

func (h *Handler) ListRoles(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	roles := repository.ListMapValues(h.Store.Roles)
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(roles, "OK", nil))
}

func (h *Handler) CreateRole(c *fiber.Ctx) error {
	body := decodeMap(c)
	role := &models.Role{ID: "role_" + randomHex(4), Name: fmt.Sprint(body["name"]), Description: fmt.Sprint(body["description"]), Permissions: parseStringSlice(body["permissions"]), CreatedAt: time.Now().UTC()}
	h.Store.Mu.Lock()
	h.Store.Roles[role.ID] = role
	h.Store.Mu.Unlock()
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
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	role, ok := h.Store.Roles[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Role not found")
	}
	if name := fmt.Sprint(body["name"]); name != "" && name != "<nil>" {
		role.Name = name
	}
	if permissions := parseStringSlice(body["permissions"]); len(permissions) > 0 {
		role.Permissions = permissions
	}
	return c.JSON(models.OK(role, "Role updated", nil))
}

func (h *Handler) DeleteRole(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	delete(h.Store.Roles, c.Params("id"))
	h.Store.Mu.Unlock()
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
