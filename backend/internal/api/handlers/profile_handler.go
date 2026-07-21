package handlers

import (
	"fmt"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

type apiKeyView struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	MaskedKey string     `json:"maskedKey"`
	Scopes    []string   `json:"scopes"`
	CreatedAt time.Time  `json:"createdAt"`
	ExpiresAt *time.Time `json:"expiresAt"`
}

type createdAPIKeyView struct {
	apiKeyView
	Key string `json:"key"`
}

func (h *Handler) GetProfile(c *fiber.Ctx) error {
	user := h.currentUser(c)
	timezone := user.Timezone
	if timezone == "" {
		timezone = "UTC"
	}
	profile := models.Profile{ID: user.ID, Name: user.Name, Email: user.Email, Role: user.Role.Name, Timezone: timezone, AvatarURL: nil, TwoFactorEnabled: user.TwoFactorEnabled}
	return c.JSON(models.OK(profile, "OK", nil))
}

func (h *Handler) UpdateProfile(c *fiber.Ctx) error {
	body := decodeMap(c)
	h.Store.Mu.Lock()
	user := h.Store.Users[h.currentUserID(c)]
	if name := fmt.Sprint(body["name"]); name != "" && name != "<nil>" {
		user.Name = name
		user.Initials = initials(name)
	}
	if timezone := strings.TrimSpace(fmt.Sprint(body["timezone"])); timezone != "" && timezone != "<nil>" {
		user.Timezone = timezone
	}
	h.Store.Mu.Unlock()
	return h.GetProfile(c)
}

func (h *Handler) UpdateSecurity(c *fiber.Ctx) error {
	return featureNotConfigured(c, "Security preference changes")
}

func (h *Handler) GetNotificationPreferences(c *fiber.Ctx) error {
	userID := h.currentUserID(c)
	h.Store.Mu.RLock()
	preferences, ok := h.Store.NotificationPreferences[userID]
	h.Store.Mu.RUnlock()
	if !ok {
		preferences = defaultNotificationPreferences()
	}
	return c.JSON(models.OK(preferences, "OK", nil))
}

func (h *Handler) UpdateNotificationPreferences(c *fiber.Ctx) error {
	var preferences models.NotificationPreferences
	if err := h.parseBody(c, &preferences); err != nil {
		return err
	}
	if preferences.Channels == nil {
		preferences.Channels = map[string]bool{}
	}
	h.Store.Mu.Lock()
	h.Store.NotificationPreferences[h.currentUserID(c)] = preferences
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(preferences, "Notification preferences updated", nil))
}

func (h *Handler) ListAPIKeys(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	keys := make([]apiKeyView, 0, len(h.Store.APIKeys))
	for _, apiKey := range h.Store.APIKeys {
		if apiKey != nil {
			keys = append(keys, publicAPIKey(*apiKey))
		}
	}
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(keys, "OK", nil))
}

func (h *Handler) CreateAPIKey(c *fiber.Ctx) error {
	body := decodeMap(c)
	key := "wf_live_" + randomHex(24)
	apiKey := &models.APIKey{ID: "key_" + randomHex(4), Name: fmt.Sprint(body["name"]), Key: key, MaskedKey: "wf_live_................" + key[len(key)-4:], Scopes: parseStringSlice(body["scopes"]), CreatedAt: time.Now().UTC()}
	h.Store.Mu.Lock()
	h.Store.APIKeys[apiKey.ID] = apiKey
	h.Store.Mu.Unlock()
	return c.Status(fiber.StatusCreated).JSON(models.OK(createdAPIKeyView{apiKeyView: publicAPIKey(*apiKey), Key: key}, "API key created. Store the key now; it will not be shown again.", nil))
}

func (h *Handler) DeleteAPIKey(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	delete(h.Store.APIKeys, c.Params("id"))
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(map[string]bool{"revoked": true}, "API key revoked", nil))
}

func defaultNotificationPreferences() models.NotificationPreferences {
	return models.NotificationPreferences{
		ExecutionFailures: true,
		HealingEvents:     true,
		BudgetWarnings:    false,
		WeeklyReports:     false,
		Channels:          map[string]bool{"inApp": true, "email": false, "webhook": false},
	}
}

func publicAPIKey(apiKey models.APIKey) apiKeyView {
	return apiKeyView{
		ID: apiKey.ID, Name: apiKey.Name, MaskedKey: apiKey.MaskedKey,
		Scopes: append([]string(nil), apiKey.Scopes...), CreatedAt: apiKey.CreatedAt, ExpiresAt: apiKey.ExpiresAt,
	}
}
