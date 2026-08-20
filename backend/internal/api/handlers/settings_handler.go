package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/redact"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"go.uber.org/zap"
)

func (h *Handler) GetSettings(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	settings := withoutSecretSettings(h.Store.Settings)
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(settings, "OK", nil))
}

func (h *Handler) PatchSettings(c *fiber.Ctx) error {
	body := decodeMap(c)
	h.Store.Mu.Lock()
	if general, ok := body["general"].(map[string]interface{}); ok {
		h.Store.Settings.General = mergeMap(h.Store.Settings.General, general)
	}
	if llm, ok := body["llm"].(map[string]interface{}); ok {
		h.Store.Settings.LLM = mergeMap(h.Store.Settings.LLM, llm)
	}
	if rbac, ok := body["rbac"].(map[string]interface{}); ok {
		h.Store.Settings.RBAC = mergeMap(h.Store.Settings.RBAC, rbac)
	}
	data := withoutSecretSettings(h.Store.Settings)
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(data, "Settings updated", nil))
}

func (h *Handler) GetGeneralSettings(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	data := withoutSecretFields(h.Store.Settings.General)
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(data, "OK", nil))
}

func (h *Handler) PatchGeneralSettings(c *fiber.Ctx) error {
	body := decodeMap(c)
	h.Store.Mu.Lock()
	h.Store.Settings.General = mergeMap(h.Store.Settings.General, body)
	data := withoutSecretFields(h.Store.Settings.General)
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(data, "General settings updated", nil))
}

func (h *Handler) GetLLMSettings(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	data := withoutSecretFields(h.Store.Settings.LLM)
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(data, "OK", nil))
}

func (h *Handler) PatchLLMSettings(c *fiber.Ctx) error {
	body := decodeMap(c)
	h.Store.Mu.Lock()
	h.Store.Settings.LLM = mergeMap(h.Store.Settings.LLM, body)
	data := withoutSecretFields(h.Store.Settings.LLM)
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(data, "LLM settings updated", nil))
}

func withoutSecretFields(values map[string]interface{}) map[string]interface{} {
	return redact.WithoutSecretFields(values)
}

func withoutNestedSecretFields(value interface{}) interface{} {
	return redact.WithoutNestedSecretFields(value)
}

func isSecretField(key string) bool {
	return redact.IsSecretField(key)
}

func withoutSecretSettings(settings models.SettingsBundle) models.SettingsBundle {
	return models.SettingsBundle{
		General: withoutSecretFields(settings.General),
		LLM:     withoutSecretFields(settings.LLM),
		RBAC:    withoutSecretFields(settings.RBAC),
	}
}

func (h *Handler) GetRBACSettings(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	data := withoutSecretFields(h.Store.Settings.RBAC)
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(data, "OK", nil))
}

func (h *Handler) PatchRBACSettings(c *fiber.Ctx) error {
	body := decodeMap(c)
	h.Store.Mu.Lock()
	h.Store.Settings.RBAC = mergeMap(h.Store.Settings.RBAC, body)
	data := withoutSecretFields(h.Store.Settings.RBAC)
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(data, "RBAC settings updated", nil))
}

func (h *Handler) ListWebhooks(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	webhooks := repository.ListMapValues(h.Store.Webhooks)
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(webhooks, "OK", nil))
}

func (h *Handler) CreateWebhook(c *fiber.Ctx) error {
	body := decodeMap(c)
	name := strings.TrimSpace(fmt.Sprint(body["name"]))
	endpoint := strings.TrimSpace(fmt.Sprint(body["url"]))
	if name == "" || name == "<nil>" {
		return fiber.NewError(fiber.StatusBadRequest, "Webhook name is required")
	}
	if _, err := outboundURL(endpoint); err != nil {
		h.logSettingsFailure("webhook.create.validate_url", "", err)
		return fiber.NewError(fiber.StatusBadRequest, "Webhook URL is invalid")
	}
	webhook := &models.Webhook{ID: "wh_" + randomHex(4), Name: name, URL: endpoint, Events: parseStringSlice(body["events"]), Enabled: true, SecretPreview: "whsec_...." + randomHex(2), CreatedAt: time.Now().UTC()}
	h.Store.Mu.Lock()
	h.Store.Webhooks[webhook.ID] = webhook
	h.Store.Mu.Unlock()
	return c.Status(fiber.StatusCreated).JSON(models.OK(webhook, "Webhook created", nil))
}

func (h *Handler) UpdateWebhook(c *fiber.Ctx) error {
	body := decodeMap(c)
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	webhook, ok := h.Store.Webhooks[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Webhook not found")
	}
	if name := fmt.Sprint(body["name"]); name != "" && name != "<nil>" {
		webhook.Name = name
	}
	if url := fmt.Sprint(body["url"]); url != "" && url != "<nil>" {
		if _, err := outboundURL(url); err != nil {
			h.logSettingsFailure("webhook.update.validate_url", webhook.ID, err)
			return fiber.NewError(fiber.StatusBadRequest, "Webhook URL is invalid")
		}
		webhook.URL = url
	}
	if events := parseStringSlice(body["events"]); len(events) > 0 {
		webhook.Events = events
	}
	if enabled, ok := body["enabled"].(bool); ok {
		webhook.Enabled = enabled
	}
	return c.JSON(models.OK(webhook, "Webhook updated", nil))
}

func (h *Handler) DeleteWebhook(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	delete(h.Store.Webhooks, c.Params("id"))
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(map[string]bool{"deleted": true}, "Webhook deleted", nil))
}

func (h *Handler) TestWebhook(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	webhook := h.Store.Webhooks[c.Params("id")]
	h.Store.Mu.RUnlock()
	if webhook == nil {
		return fiber.NewError(fiber.StatusNotFound, "Webhook not found")
	}
	payload, err := json.Marshal(map[string]interface{}{"type": "webhook.test", "webhookId": webhook.ID, "sentAt": time.Now().UTC()})
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Could not encode webhook test")
	}
	result, err := probeEndpoint(http.MethodPost, webhook.URL, payload)
	if err != nil {
		h.logSettingsFailure("webhook.test", webhook.ID, err)
		return c.Status(fiber.StatusBadGateway).JSON(models.Fail("Webhook connection test failed", nil))
	}
	return c.JSON(models.OK(result, "Webhook test delivered", nil))
}

func (h *Handler) ListIntegrations(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	integrations := make([]models.Integration, 0, len(h.Store.Integrations))
	for _, integration := range h.Store.Integrations {
		if integration != nil {
			integrations = append(integrations, publicIntegration(*integration))
		}
	}
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(integrations, "OK", nil))
}

func (h *Handler) CreateIntegration(c *fiber.Ctx) error {
	body := decodeMap(c)
	name := strings.TrimSpace(fmt.Sprint(body["name"]))
	integrationType := strings.TrimSpace(fmt.Sprint(body["type"]))
	if name == "" || name == "<nil>" || integrationType == "" || integrationType == "<nil>" {
		return fiber.NewError(fiber.StatusBadRequest, "Integration name and type are required")
	}
	integration := &models.Integration{ID: "int_" + randomHex(4), Name: name, Type: integrationType, Status: "Disconnected", Icon: "mdi:connection", Config: map[string]interface{}{}, CreatedAt: time.Now().UTC()}
	if cfg, ok := body["config"].(map[string]interface{}); ok {
		integration.Config = cfg
	}
	h.Store.Mu.Lock()
	h.Store.Integrations[integration.ID] = integration
	h.Store.Mu.Unlock()
	return c.Status(fiber.StatusCreated).JSON(models.OK(publicIntegration(*integration), "Integration created", nil))
}

func (h *Handler) GetIntegration(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	integration, ok := h.Store.Integrations[c.Params("id")]
	h.Store.Mu.RUnlock()
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Integration not found")
	}
	return c.JSON(models.OK(publicIntegration(*integration), "OK", nil))
}

func (h *Handler) UpdateIntegration(c *fiber.Ctx) error {
	body := decodeMap(c)
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	integration, ok := h.Store.Integrations[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Integration not found")
	}
	if status := fmt.Sprint(body["status"]); status != "" && status != "<nil>" {
		integration.Status = status
	}
	if cfg, ok := body["config"].(map[string]interface{}); ok {
		integration.Config = mergeMap(integration.Config, cfg)
	}
	return c.JSON(models.OK(publicIntegration(*integration), "Integration updated", nil))
}

func (h *Handler) DeleteIntegration(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	delete(h.Store.Integrations, c.Params("id"))
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(map[string]bool{"deleted": true}, "Integration deleted", nil))
}

func (h *Handler) TestIntegration(c *fiber.Ctx) error {
	now := time.Now().UTC()
	h.Store.Mu.RLock()
	integration := h.Store.Integrations[c.Params("id")]
	h.Store.Mu.RUnlock()
	if integration == nil {
		return fiber.NewError(fiber.StatusNotFound, "Integration not found")
	}
	endpoint := integrationEndpoint(integration.Config)
	result, err := probeEndpoint(http.MethodGet, endpoint, nil)
	if err != nil {
		h.logSettingsFailure("integration.test", integration.ID, err)
		return c.Status(fiber.StatusBadGateway).JSON(models.Fail("Integration connection test failed", map[string]interface{}{"checkedAt": now}))
	}
	h.Store.Mu.Lock()
	integration.LastTestedAt = &now
	h.Store.Mu.Unlock()
	result["checkedAt"] = now
	return c.JSON(models.OK(result, "Integration test passed", nil))
}

func (h *Handler) ConnectIntegration(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	integration := h.Store.Integrations[c.Params("id")]
	h.Store.Mu.RUnlock()
	if integration == nil {
		return fiber.NewError(fiber.StatusNotFound, "Integration not found")
	}
	if _, err := probeEndpoint(http.MethodGet, integrationEndpoint(integration.Config), nil); err != nil {
		h.logSettingsFailure("integration.connect", integration.ID, err)
		return c.Status(fiber.StatusBadGateway).JSON(models.Fail("Integration connection failed", nil))
	}
	return h.setIntegrationStatus(c, "Connected")
}

func (h *Handler) DisconnectIntegration(c *fiber.Ctx) error {
	return h.setIntegrationStatus(c, "Disconnected")
}

func (h *Handler) setIntegrationStatus(c *fiber.Ctx, status string) error {
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	integration, ok := h.Store.Integrations[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Integration not found")
	}
	integration.Status = status
	return c.JSON(models.OK(publicIntegration(*integration), "Integration status updated", nil))
}

func publicIntegration(integration models.Integration) models.Integration {
	integration.Config = withoutSecretFields(integration.Config)
	return integration
}

func integrationEndpoint(config map[string]interface{}) string {
	for _, key := range []string{"baseUrl", "url", "endpoint"} {
		if value := strings.TrimSpace(fmt.Sprint(config[key])); value != "" && value != "<nil>" {
			return value
		}
	}
	return ""
}

func (h *Handler) logSettingsFailure(operation, resourceID string, err error) {
	if h.Log == nil || err == nil {
		return
	}
	h.Log.Error(
		"settings operation failed",
		zap.String("operation", operation),
		zap.String("resource_id", resourceID),
		zap.Error(err),
	)
}

func outboundURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, fmt.Errorf("a valid http or https URL is required")
	}
	if parsed.User != nil {
		return nil, fmt.Errorf("credentials must not be embedded in URLs")
	}
	return parsed, nil
}

func probeEndpoint(method, endpoint string, body []byte) (map[string]interface{}, error) {
	if _, err := outboundURL(endpoint); err != nil {
		return nil, err
	}
	request, err := http.NewRequest(method, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	started := time.Now()
	client := &http.Client{
		Timeout: 10 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	latency := time.Since(started).Milliseconds()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("endpoint returned HTTP %d", response.StatusCode)
	}
	return map[string]interface{}{"connected": true, "delivered": true, "statusCode": response.StatusCode, "latencyMs": latency}, nil
}
