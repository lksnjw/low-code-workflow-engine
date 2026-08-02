package handlers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares"
	"github.com/sanjeewa/agentic-orchestrator/internal/config"
	generationcontext "github.com/sanjeewa/agentic-orchestrator/internal/core/context"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/healing"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/importer"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/orchestrator"
	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/runner"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/semanticsearch"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/synthesizer"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"go.uber.org/zap"
)

type Handler struct {
	Cfg               config.Config
	Store             *repository.Store
	Synth             *synthesizer.Service
	Validator         *workflowvalidator.WorkflowValidator
	Dataset           *coreregistry.Bundle
	RegistryManager   *coreregistry.Manager
	RegistryContext   *generationcontext.Service
	Importer          *importer.Service
	RegistryValidator *workflowvalidator.RegistryValidator
	Search            *semanticsearch.Service
	Orchestrator      *orchestrator.ChatOrchestrator
	Runner            *runner.Executor
	Healer            *healing.Healer
	Log               *zap.Logger
}

func New(cfg config.Config, store *repository.Store, synth *synthesizer.Service, validator *workflowvalidator.WorkflowValidator, dataset *coreregistry.Bundle, registryValidator *workflowvalidator.RegistryValidator, search *semanticsearch.Service, chatOrch *orchestrator.ChatOrchestrator, exec *runner.Executor, healer *healing.Healer, log *zap.Logger) *Handler {
	if registryValidator == nil {
		panic("handler requires a registry validator")
	}
	manager := coreregistry.NewManager(dataset, cfg.ToolRegistryPath, cfg.RuleRegistryPath)
	contextService := generationcontext.NewService(manager, log)
	handler := &Handler{Cfg: cfg, Store: store, Synth: synth, Validator: validator, Dataset: dataset, RegistryManager: manager, RegistryContext: contextService, Importer: importer.NewServiceWithContext(manager, contextService, log), RegistryValidator: registryValidator, Search: search, Orchestrator: chatOrch, Runner: exec, Healer: healer, Log: log}
	if synth != nil && store != nil {
		synth.SetProviderResolver(store.ActiveProvider)
	}
	if synth != nil && exec != nil {
		exec.SetAnalysisProvider(synth)
	}
	if synth != nil && strings.TrimSpace(cfg.ToolRegistryPath) != "" && strings.TrimSpace(cfg.RuleRegistryPath) != "" {
		synth.SetRegistryContext(contextService)
		synth.SetLogger(log)
	}
	return handler
}

func (h *Handler) Health(c *fiber.Ctx) error {
	probeContext, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	durable, storageHealthy := h.Store.ProbePersistence(probeContext)
	status := "healthy"
	storageStatus := "healthy"
	statusCode := fiber.StatusOK
	if !storageHealthy {
		status = "degraded"
		storageStatus = "unhealthy"
		statusCode = fiber.StatusServiceUnavailable
	}
	data := map[string]interface{}{
		"service":     h.Cfg.AppName,
		"environment": h.Cfg.Environment,
		"status":      status,
		"storage": map[string]interface{}{
			"driver":  h.Cfg.StorageDriver,
			"durable": durable,
			"status":  storageStatus,
		},
		"time": time.Now().UTC(),
	}
	if !storageHealthy {
		return c.Status(statusCode).JSON(models.APIResponse{Success: false, Data: data, Message: "Storage persistence is degraded", Meta: nil})
	}
	return c.Status(statusCode).JSON(models.OK(data, "OK", nil))
}

func (h *Handler) parseBody(c *fiber.Ctx, target interface{}) error {
	if err := c.BodyParser(target); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
	}
	return nil
}

func (h *Handler) currentUserID(c *fiber.Ctx) string {
	userID, _ := c.Locals(middlewares.UserIDKey).(string)
	return userID
}

func (h *Handler) currentUser(c *fiber.Ctx) *models.User {
	userID := h.currentUserID(c)
	if user, ok := h.Store.EffectiveUser(userID); ok {
		return user
	}
	return nil
}

func (h *Handler) RequireUser(c *fiber.Ctx) error {
	userID := h.currentUserID(c)
	h.Store.Mu.RLock()
	user, exists := h.Store.Users[userID]
	active := exists && user != nil && strings.EqualFold(user.Status, "active")
	h.Store.Mu.RUnlock()
	if !exists || user == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(models.Fail("Authenticated user no longer exists", nil))
	}
	if !active {
		return c.Status(fiber.StatusForbidden).JSON(models.Fail("User account is not active", nil))
	}
	return c.Next()
}

func (h *Handler) permissions(c *fiber.Ctx) []string {
	user := h.currentUser(c)
	if user == nil {
		return nil
	}
	return append([]string{}, user.Permissions...)
}

// Permissions exposes the authenticated principal's permissions to route
// middleware without leaking the store into the routing package.
func (h *Handler) Permissions(c *fiber.Ctx) []string {
	return h.permissions(c)
}

func (h *Handler) validateWithFullGate(c *fiber.Ctx, action, rawYAML string) (*models.ValidationToken, *workflowvalidator.CandidateValidationResult, error) {
	userRole := "anonymous"
	if user := h.currentUser(c); user != nil {
		userRole = user.Role.Name
	}
	return h.RegistryValidator.ValidateAndIssueToken(action, rawYAML, userRole)
}

func principalFromUser(user *models.User) models.Principal {
	if user == nil {
		return models.Principal{ID: "system", Name: "System"}
	}
	return models.Principal{ID: user.ID, Name: user.Name}
}

func (h *Handler) publicUser(user *models.User) map[string]interface{} {
	if user == nil {
		return nil
	}
	effective, ok := h.Store.EffectiveUser(user.ID)
	if ok {
		user = effective
	}
	return publicUserSnapshot(user)
}

func publicUserSnapshot(user *models.User) map[string]interface{} {
	if user == nil {
		return nil
	}
	return map[string]interface{}{
		"id":                  user.ID,
		"name":                user.Name,
		"email":               user.Email,
		"role":                user.Role.Name,
		"roleId":              user.AssignedRoleID(),
		"permissions":         append([]string{}, user.Permissions...),
		"permissionOverrides": append([]string{}, user.PermissionOverrides...),
		"status":              user.Status,
		"initials":            user.Initials,
		"timezone":            user.Timezone,
		"departmentId":        user.DepartmentID,
		"twoFactorEnabled":    user.TwoFactorEnabled,
		"emailVerified":       user.EmailVerified,
	}
}

func (h *Handler) tokenForUser(userID string) (models.TokenPair, error) {
	now := time.Now()
	claims := jwt.MapClaims{
		"sub": userID,
		"iat": now.Unix(),
		"exp": now.Add(h.Cfg.TokenTTL).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	access, err := token.SignedString([]byte(h.Cfg.JWTSecret))
	if err != nil {
		return models.TokenPair{}, err
	}

	return models.TokenPair{
		AccessToken:  access,
		RefreshToken: "refresh_" + randomHex(24),
		ExpiresIn:    int(h.Cfg.TokenTTL.Seconds()),
	}, nil
}

func randomHex(size int) string {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buffer)
}

func (h *Handler) tracedBusinessError(status int, operation, message string, err error) error {
	traceID := randomHex(8)
	if h.Log != nil {
		h.Log.Error(operation, zap.String("trace_id", traceID), zap.Error(err))
	}
	return fiber.NewError(status, message+" Contact support with trace ID "+traceID+".")
}

func pageLimit(c *fiber.Ctx) (int, int) {
	page := c.QueryInt("page", 1)
	limit := c.QueryInt("limit", 20)
	if page < 1 {
		page = 1
	}
	if limit < 1 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	return page, limit
}

func paginate[T any](items []T, page, limit int) ([]T, models.PaginationMeta) {
	total := len(items)
	totalPages := int(math.Ceil(float64(total) / float64(limit)))
	start := (page - 1) * limit
	if start > total {
		return []T{}, models.PaginationMeta{Page: page, Limit: limit, Total: total, TotalPages: totalPages}
	}
	end := start + limit
	if end > total {
		end = total
	}
	return items[start:end], models.PaginationMeta{Page: page, Limit: limit, Total: total, TotalPages: totalPages}
}

func mergeMap(dst map[string]interface{}, src map[string]interface{}) map[string]interface{} {
	if dst == nil {
		dst = map[string]interface{}{}
	}
	for key, value := range src {
		if value != nil {
			dst[key] = value
		}
	}
	return dst
}

func decodeMap(c *fiber.Ctx) map[string]interface{} {
	payload := map[string]interface{}{}
	_ = c.BodyParser(&payload)
	return payload
}

func initials(name string) string {
	parts := strings.Fields(name)
	if len(parts) == 0 {
		return "U"
	}
	out := ""
	for _, part := range parts {
		out += strings.ToUpper(part[:1])
		if len(out) == 2 {
			break
		}
	}
	return out
}

func parseStringSlice(value interface{}) []string {
	switch typed := value.(type) {
	case []string:
		return typed
	case []interface{}:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			out = append(out, fmt.Sprint(item))
		}
		return out
	case string:
		if typed == "" {
			return []string{}
		}
		return strings.Split(typed, ",")
	default:
		return []string{}
	}
}

func queryMeta(c *fiber.Ctx, keys ...string) map[string]interface{} {
	meta := map[string]interface{}{}
	for _, key := range keys {
		if value := c.Query(key); value != "" {
			meta[key] = value
		}
	}
	return meta
}

func toInt(value interface{}, fallback int) int {
	switch typed := value.(type) {
	case int:
		return typed
	case float64:
		return int(typed)
	case string:
		parsed, err := strconv.Atoi(typed)
		if err == nil {
			return parsed
		}
	}
	return fallback
}
