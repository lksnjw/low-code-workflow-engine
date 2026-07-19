package main

import (
	"log"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/handlers"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/routes"
	"github.com/sanjeewa/agentic-orchestrator/internal/config"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/healing"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/orchestrator"
	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/runner"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/semanticsearch"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/synthesizer"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools/impl"
	agentlogger "github.com/sanjeewa/agentic-orchestrator/pkg/logger"
	"go.uber.org/zap"
)

func main() {
	cfg := config.Load()
	zapLogger, err := agentlogger.New(cfg.Environment)
	if err != nil {
		log.Fatalf("create logger: %v", err)
	}
	defer zapLogger.Sync()
	if err := cfg.Validate(); err != nil {
		zapLogger.Fatal("invalid server configuration", zap.Error(err))
	}

	_ = config.NewDatabase(cfg, zapLogger)
	_ = config.NewRedisCache(cfg, zapLogger)

	store := repository.NewStore()
	repository.ApplyDevUserRole(store, cfg.DevUserRole)
	store.Settings.General = map[string]interface{}{
		"appName": cfg.AppName, "environment": cfg.Environment, "frontendUrl": cfg.FrontendURL,
	}
	store.Settings.LLM = map[string]interface{}{
		"provider": cfg.WorkflowGenerationProvider, "model": cfg.GeminiModel,
		"semanticSearchMode": cfg.SemanticSearchMode, "managedByEnvironment": true,
	}
	store.Settings.RBAC = map[string]interface{}{
		"developmentAuthEnabled": cfg.AllowDevAuth, "defaultRoleId": "role_builder",
	}
	synth := synthesizer.NewServiceWithProvider(cfg.OllamaBaseURL, cfg.OllamaModel, cfg.OllamaEnabled, cfg.WorkflowGenerationProvider, cfg.GeminiAPIKey, cfg.GeminiModel)
	validator := workflowvalidator.NewWorkflowValidator()
	var registryBundle *coreregistry.Bundle
	if cfg.ToolRegistryPath != "" && cfg.RuleRegistryPath != "" {
		registryBundle, err = coreregistry.LoadBundle(cfg.ToolRegistryPath, cfg.RuleRegistryPath, zapLogger)
	} else {
		registryBundle, err = coreregistry.LoadDataset(cfg.DatasetRoot, zapLogger)
	}
	if err != nil {
		zapLogger.Fatal("load semantic registries", zap.Error(err))
	}
	registryValidator := workflowvalidator.NewRegistryValidator(registryBundle.Tools, registryBundle.Rules, store)
	searchService := semanticsearch.NewServiceFromDataset(registryBundle, cfg.SemanticSearchMode, cfg.SemanticSearchURL, cfg.SemanticSearchAllowLexicalFallback)
	chatOrchestrator := orchestrator.NewChatOrchestrator(searchService, synth, registryValidator)
	mcp := tools.NewMCPClient(cfg.MCPBaseURL, cfg.MCPTimeout)
	registry := tools.NewRegistry(nil)
	registry.Register(impl.FetchAttendanceTool{MCP: mcp})
	registry.Register(impl.CreateLeaveTool{MCP: mcp})
	registry.Register(tools.GenericMCPTool{Action: "classify_invoice", Client: mcp})
	registry.Register(tools.GenericMCPTool{Action: "policy_check", Client: mcp})
	registry.Register(tools.GenericMCPTool{Action: "refresh_connector", Client: mcp})
	registry.Register(tools.GenericMCPTool{Action: "notify_finance", Client: mcp})
	registry.Register(tools.GenericMCPTool{Action: "send_webhook", Client: mcp})
	for _, toolDef := range registryBundle.Tools.GetAllTools() {
		if !registry.Has(toolDef.Name) {
			registry.Register(tools.GenericMCPTool{Action: toolDef.Name, Client: mcp})
		}
	}

	exec := runner.NewExecutor(registry, registryValidator, zapLogger)
	exec.SetBaselineB(cfg.BaselineBEnabled())
	healer := healing.NewHealer(synth)
	handler := handlers.New(cfg, store, synth, validator, registryBundle, registryValidator, searchService, chatOrchestrator, exec, healer, zapLogger)

	app := fiber.New(fiber.Config{
		AppName:      cfg.AppName,
		ServerHeader: "agentic-orchestrator",
		ErrorHandler: func(c *fiber.Ctx, err error) error {
			code := fiber.StatusInternalServerError
			message := "Internal server error"
			if e, ok := err.(*fiber.Error); ok {
				code = e.Code
				message = e.Message
			}
			zapLogger.Warn("request failed", zap.Int("status", code), zap.String("path", c.Path()), zap.Error(err))
			return c.Status(code).JSON(map[string]interface{}{"success": false, "data": nil, "message": message, "meta": nil})
		},
	})
	app.Use(cors.New(cors.Config{
		AllowOrigins:     cfg.FrontendURL + ",http://localhost:5173,http://127.0.0.1:5173",
		AllowHeaders:     "Origin, Content-Type, Accept, Authorization",
		AllowMethods:     "GET,POST,PATCH,PUT,DELETE,OPTIONS",
		AllowCredentials: true,
	}))
	app.Use(middlewares.RequestLogger(zapLogger))

	routes.Register(app, handler)

	addr := cfg.Host + ":" + cfg.Port
	zapLogger.Info("agentic orchestrator backend listening", zap.String("addr", addr), zap.String("api", cfg.APIBasePath))
	if err := app.Listen(addr); err != nil {
		zapLogger.Fatal("server stopped", zap.Error(err))
	}
}
