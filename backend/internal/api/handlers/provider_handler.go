package handlers

import (
	"sort"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

type providerConfigRequest struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	BaseURL string `json:"baseUrl"`
	Model   string `json:"model"`
	APIKey  string `json:"apiKey"`
}

type providerConfigView struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Type       string    `json:"type"`
	BaseURL    string    `json:"baseUrl,omitempty"`
	Model      string    `json:"model"`
	KeyPreview string    `json:"keyPreview"`
	Active     bool      `json:"active"`
	CreatedAt  time.Time `json:"createdAt"`
}

func (h *Handler) ListProviders(c *fiber.Ctx) error {
	if err := h.requirePlatformAdmin(c); err != nil {
		return err
	}
	h.Store.Mu.RLock()
	items := make([]providerConfigView, 0, len(h.Store.Providers))
	for _, provider := range h.Store.Providers {
		items = append(items, providerView(*provider))
	}
	h.Store.Mu.RUnlock()
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.Before(items[j].CreatedAt) })
	return c.JSON(models.OK(items, "Provider configurations loaded", map[string]interface{}{"count": len(items)}))
}

func (h *Handler) CreateProvider(c *fiber.Ctx) error {
	if err := h.requirePlatformAdmin(c); err != nil {
		return err
	}
	var request providerConfigRequest
	if err := h.parseBody(c, &request); err != nil {
		return err
	}
	provider, err := providerFromRequest(request, "")
	if err != nil {
		return fiber.NewError(fiber.StatusUnprocessableEntity, err.Error())
	}
	provider.ID = h.Store.NextID("provider")
	provider.CreatedAt = time.Now().UTC()

	h.Store.Mu.Lock()
	for _, existing := range h.Store.Providers {
		if strings.EqualFold(existing.Name, provider.Name) {
			h.Store.Mu.Unlock()
			return fiber.NewError(fiber.StatusConflict, "Provider name already exists")
		}
	}
	provider.Active = len(h.Store.Providers) == 0
	h.Store.Providers[provider.ID] = &provider
	h.Store.Audit(principalFromUser(h.Store.Users[h.currentUserID(c)]), "provider.created", models.ResourceRef{Type: "provider", ID: provider.ID}, nil, providerAuditState(provider), c.IP(), c.Get("User-Agent"))
	h.Store.Mu.Unlock()
	return c.Status(fiber.StatusCreated).JSON(models.OK(providerView(provider), "Provider configuration created", nil))
}

func (h *Handler) UpdateProvider(c *fiber.Ctx) error {
	if err := h.requirePlatformAdmin(c); err != nil {
		return err
	}
	var request providerConfigRequest
	if err := h.parseBody(c, &request); err != nil {
		return err
	}
	h.Store.Mu.Lock()
	existing := h.Store.Providers[c.Params("id")]
	if existing == nil {
		h.Store.Mu.Unlock()
		return fiber.NewError(fiber.StatusNotFound, "Provider configuration not found")
	}
	updated, err := providerFromRequest(request, existing.APIKey)
	if err != nil {
		h.Store.Mu.Unlock()
		return fiber.NewError(fiber.StatusUnprocessableEntity, err.Error())
	}
	for _, candidate := range h.Store.Providers {
		if candidate.ID != existing.ID && strings.EqualFold(candidate.Name, updated.Name) {
			h.Store.Mu.Unlock()
			return fiber.NewError(fiber.StatusConflict, "Provider name already exists")
		}
	}
	before := providerAuditState(*existing)
	updated.ID = existing.ID
	updated.Active = existing.Active
	updated.CreatedAt = existing.CreatedAt
	h.Store.Providers[updated.ID] = &updated
	h.Store.Audit(principalFromUser(h.Store.Users[h.currentUserID(c)]), "provider.updated", models.ResourceRef{Type: "provider", ID: updated.ID}, before, providerAuditState(updated), c.IP(), c.Get("User-Agent"))
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(providerView(updated), "Provider configuration updated", nil))
}

func (h *Handler) ActivateProvider(c *fiber.Ctx) error {
	if err := h.requirePlatformAdmin(c); err != nil {
		return err
	}
	h.Store.Mu.Lock()
	provider := h.Store.Providers[c.Params("id")]
	if provider == nil {
		h.Store.Mu.Unlock()
		return fiber.NewError(fiber.StatusNotFound, "Provider configuration not found")
	}
	before := providerAuditState(*provider)
	for _, candidate := range h.Store.Providers {
		candidate.Active = candidate.ID == provider.ID
	}
	h.Store.Audit(principalFromUser(h.Store.Users[h.currentUserID(c)]), "provider.activated", models.ResourceRef{Type: "provider", ID: provider.ID}, before, providerAuditState(*provider), c.IP(), c.Get("User-Agent"))
	view := providerView(*provider)
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(view, "Provider activated", nil))
}

func (h *Handler) TestProvider(c *fiber.Ctx) error {
	if err := h.requirePlatformAdmin(c); err != nil {
		return err
	}
	h.Store.Mu.RLock()
	provider := h.Store.Providers[c.Params("id")]
	if provider == nil {
		h.Store.Mu.RUnlock()
		return fiber.NewError(fiber.StatusNotFound, "Provider configuration not found")
	}
	config := *provider
	h.Store.Mu.RUnlock()
	if h.Synth == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "Synthesis service is not configured")
	}
	if err := h.Synth.TestProvider(c.Context(), config); err != nil {
		return c.JSON(models.OK(map[string]interface{}{"ok": false, "message": "Provider connection failed"}, "Provider connection test completed", nil))
	}
	return c.JSON(models.OK(map[string]interface{}{"ok": true, "message": "Connection successful"}, "Provider connection test completed", nil))
}

func providerFromRequest(request providerConfigRequest, existingKey string) (models.ProviderConfig, error) {
	provider := models.ProviderConfig{
		Name: strings.TrimSpace(request.Name), Type: strings.ToLower(strings.TrimSpace(request.Type)),
		BaseURL: strings.TrimRight(strings.TrimSpace(request.BaseURL), "/"), Model: strings.TrimSpace(request.Model),
		APIKey: strings.TrimSpace(request.APIKey),
	}
	if provider.APIKey == "" {
		provider.APIKey = existingKey
	}
	if provider.Name == "" || provider.Model == "" {
		return models.ProviderConfig{}, fiber.NewError(fiber.StatusUnprocessableEntity, "Provider name and model are required")
	}
	switch provider.Type {
	case "gemini":
		if provider.APIKey == "" {
			return models.ProviderConfig{}, fiber.NewError(fiber.StatusUnprocessableEntity, "API key is required for Gemini")
		}
	case "ollama":
		if provider.BaseURL == "" {
			return models.ProviderConfig{}, fiber.NewError(fiber.StatusUnprocessableEntity, "Base URL is required for Ollama")
		}
	case "openai_compatible":
		if provider.BaseURL == "" || provider.APIKey == "" {
			return models.ProviderConfig{}, fiber.NewError(fiber.StatusUnprocessableEntity, "Base URL and API key are required for OpenAI-compatible providers")
		}
	default:
		return models.ProviderConfig{}, fiber.NewError(fiber.StatusUnprocessableEntity, "Provider type must be gemini, ollama, or openai_compatible")
	}
	if provider.BaseURL != "" {
		parsed, err := outboundURL(provider.BaseURL)
		if err != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return models.ProviderConfig{}, fiber.NewError(fiber.StatusUnprocessableEntity, "Base URL must be a credential-free http or https origin/path")
		}
	}
	return provider, nil
}

func providerView(provider models.ProviderConfig) providerConfigView {
	return providerConfigView{
		ID: provider.ID, Name: provider.Name, Type: provider.Type, BaseURL: provider.BaseURL,
		Model: provider.Model, KeyPreview: keyPreview(provider.APIKey), Active: provider.Active, CreatedAt: provider.CreatedAt,
	}
}

func providerAuditState(provider models.ProviderConfig) map[string]interface{} {
	return map[string]interface{}{
		"name": provider.Name, "type": provider.Type, "baseUrl": provider.BaseURL,
		"model": provider.Model, "active": provider.Active, "credentialConfigured": provider.APIKey != "",
	}
}

func keyPreview(key string) string {
	runes := []rune(strings.TrimSpace(key))
	if len(runes) == 0 {
		return ""
	}
	if len(runes) > 4 {
		runes = runes[:4]
	}
	return string(runes) + "••••"
}

func (h *Handler) requirePlatformAdmin(c *fiber.Ctx) error {
	user := h.currentUser(c)
	if user == nil {
		return fiber.NewError(fiber.StatusUnauthorized, "Authenticated user no longer exists")
	}
	if user.AssignedRoleID() != repository.RolePlatformAdminID {
		return fiber.NewError(fiber.StatusForbidden, "Provider configuration is restricted to Platform Admins")
	}
	return nil
}
