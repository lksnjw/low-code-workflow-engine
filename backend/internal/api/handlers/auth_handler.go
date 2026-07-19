package handlers

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"golang.org/x/crypto/bcrypt"
)

var dummyPasswordHash, _ = bcrypt.GenerateFromPassword([]byte("invalid-password"), bcrypt.DefaultCost)

func (h *Handler) Login(c *fiber.Ctx) error {
	var req models.LoginRequest
	if err := h.parseBody(c, &req); err != nil {
		return err
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if email == "" || req.Password == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Email and password are required")
	}

	h.Store.Mu.RLock()
	var user *models.User
	var passwordHash string
	for _, candidate := range h.Store.Users {
		if strings.EqualFold(candidate.Email, email) {
			user = candidate
			passwordHash = h.Store.PasswordHashes[candidate.ID]
			break
		}
	}
	h.Store.Mu.RUnlock()

	hash := []byte(passwordHash)
	if user == nil || passwordHash == "" {
		hash = dummyPasswordHash
	}
	if bcrypt.CompareHashAndPassword(hash, []byte(req.Password)) != nil || user == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.Fail("Invalid email or password", nil))
	}
	if !strings.EqualFold(user.Status, "active") {
		return c.Status(fiber.StatusForbidden).JSON(models.Fail("User account is not active", nil))
	}

	tokens, err := h.tokenForUser(user.ID)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Could not sign access token")
	}

	now := time.Now().UTC()
	refreshTTL := 7 * 24 * time.Hour
	if req.RememberMe {
		refreshTTL = 30 * 24 * time.Hour
	}
	h.Store.Mu.Lock()
	user.LastLoginAt = &now
	h.Store.RefreshSessions[refreshTokenDigest(tokens.RefreshToken)] = repository.RefreshSession{UserID: user.ID, ExpiresAt: now.Add(refreshTTL)}
	h.Store.Mu.Unlock()

	session := models.AuthSession{
		AccessToken: tokens.AccessToken, RefreshToken: tokens.RefreshToken, ExpiresIn: tokens.ExpiresIn,
		User: publicUser(user),
	}
	return c.JSON(models.OK(session, "Login successful", nil))
}

func (h *Handler) Register(c *fiber.Ctx) error {
	var req models.RegisterRequest
	if err := h.parseBody(c, &req); err != nil {
		return err
	}
	req.Name = strings.TrimSpace(req.Name)
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	if req.Name == "" || req.Email == "" || len(req.Password) < 8 {
		return fiber.NewError(fiber.StatusBadRequest, "Name, a valid email, and a password of at least 8 characters are required")
	}

	passwordHash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Could not secure password")
	}

	h.Store.Mu.Lock()
	for _, existing := range h.Store.Users {
		if strings.EqualFold(existing.Email, req.Email) {
			h.Store.Mu.Unlock()
			return c.Status(fiber.StatusConflict).JSON(models.Fail("An account with this email already exists", nil))
		}
	}

	roleID := "role_builder"
	if len(h.Store.Users) == 0 {
		// The first registered account bootstraps administration for an empty install.
		roleID = "role_admin"
	}
	role := h.Store.Roles[roleID]
	if role == nil {
		h.Store.Mu.Unlock()
		return fiber.NewError(fiber.StatusInternalServerError, "Default role is not configured")
	}

	now := time.Now().UTC()
	id := h.Store.NextID("usr")
	user := &models.User{
		ID: id, Name: req.Name, Email: req.Email, Role: models.RoleRef{ID: role.ID, Name: role.Name},
		Permissions: append([]string{}, role.Permissions...), Status: "Active", Initials: initials(req.Name),
		Timezone: "UTC", CreatedAt: now, EmailVerified: false,
	}
	h.Store.Users[id] = user
	h.Store.PasswordHashes[id] = string(passwordHash)
	h.Store.Audit(principalFromUser(user), "user.registered", models.ResourceRef{Type: "user", ID: id}, nil, map[string]interface{}{"email": req.Email, "roleId": role.ID}, c.IP(), c.Get("User-Agent"))
	h.Store.Mu.Unlock()

	tokens, err := h.tokenForUser(id)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Could not sign access token")
	}
	h.Store.Mu.Lock()
	h.Store.RefreshSessions[refreshTokenDigest(tokens.RefreshToken)] = repository.RefreshSession{UserID: id, ExpiresAt: now.Add(7 * 24 * time.Hour)}
	h.Store.Mu.Unlock()

	session := models.AuthSession{AccessToken: tokens.AccessToken, RefreshToken: tokens.RefreshToken, ExpiresIn: tokens.ExpiresIn, User: publicUser(user)}
	return c.Status(fiber.StatusCreated).JSON(models.OK(session, "Registration successful", nil))
}

func (h *Handler) Logout(c *fiber.Ctx) error {
	var body struct {
		RefreshToken string `json:"refreshToken"`
	}
	_ = c.BodyParser(&body)
	if body.RefreshToken != "" {
		h.Store.Mu.Lock()
		delete(h.Store.RefreshSessions, refreshTokenDigest(body.RefreshToken))
		h.Store.Mu.Unlock()
	}
	return c.JSON(models.OK(map[string]bool{"loggedOut": true}, "Logged out", nil))
}

func (h *Handler) Refresh(c *fiber.Ctx) error {
	var body struct {
		RefreshToken string `json:"refreshToken"`
	}
	if err := h.parseBody(c, &body); err != nil {
		return err
	}
	if strings.TrimSpace(body.RefreshToken) == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Refresh token is required")
	}

	digest := refreshTokenDigest(body.RefreshToken)
	now := time.Now().UTC()
	h.Store.Mu.Lock()
	session, ok := h.Store.RefreshSessions[digest]
	if ok {
		delete(h.Store.RefreshSessions, digest)
	}
	user := h.Store.Users[session.UserID]
	h.Store.Mu.Unlock()
	if !ok || session.ExpiresAt.Before(now) || user == nil || !strings.EqualFold(user.Status, "active") {
		return c.Status(fiber.StatusUnauthorized).JSON(models.Fail("Invalid or expired refresh token", nil))
	}

	tokens, err := h.tokenForUser(user.ID)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Could not refresh token")
	}
	h.Store.Mu.Lock()
	h.Store.RefreshSessions[refreshTokenDigest(tokens.RefreshToken)] = repository.RefreshSession{UserID: user.ID, ExpiresAt: now.Add(7 * 24 * time.Hour)}
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(models.AuthSession{AccessToken: tokens.AccessToken, RefreshToken: tokens.RefreshToken, ExpiresIn: tokens.ExpiresIn, User: publicUser(user)}, "Token refreshed", nil))
}

func (h *Handler) Me(c *fiber.Ctx) error {
	user := h.currentUser(c)
	if user == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.Fail("Authenticated user no longer exists", nil))
	}
	return c.JSON(models.OK(publicUser(user), "OK", nil))
}

func (h *Handler) ForgotPassword(c *fiber.Ctx) error {
	return featureNotConfigured(c, "Password recovery")
}
func (h *Handler) ResetPassword(c *fiber.Ctx) error {
	return featureNotConfigured(c, "Password recovery")
}
func (h *Handler) VerifyEmail(c *fiber.Ctx) error {
	return featureNotConfigured(c, "Email verification")
}
func (h *Handler) TwoFactorVerify(c *fiber.Ctx) error {
	return featureNotConfigured(c, "Two-factor authentication")
}
func (h *Handler) TwoFactorEnable(c *fiber.Ctx) error {
	return featureNotConfigured(c, "Two-factor authentication")
}
func (h *Handler) TwoFactorDisable(c *fiber.Ctx) error {
	return featureNotConfigured(c, "Two-factor authentication")
}
func (h *Handler) OAuthAuthorize(c *fiber.Ctx) error { return featureNotConfigured(c, "OAuth") }
func (h *Handler) OAuthCallback(c *fiber.Ctx) error  { return featureNotConfigured(c, "OAuth") }

func featureNotConfigured(c *fiber.Ctx, feature string) error {
	return c.Status(fiber.StatusNotImplemented).JSON(models.Fail(feature+" is not configured for this installation", nil))
}

func refreshTokenDigest(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}
