package main

import (
	"context"
	"log"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/handlers"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/middlewares"
	"github.com/sanjeewa/agentic-orchestrator/internal/api/routes"
	"github.com/sanjeewa/agentic-orchestrator/internal/config"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/healing"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/orchestrator"
	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/relevance"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/runner"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/semanticsearch"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/synthesizer"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/internal/storage"
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
	if strings.TrimSpace(cfg.MCPBaseURL) != "" {
		inspectContext, cancelInspect := context.WithTimeout(context.Background(), 750*time.Millisecond)
		mcpBackend, inspectErr := config.InspectMCPBackend(inspectContext, cfg.MCPBaseURL)
		cancelInspect()
		if inspectErr != nil {
			zapLogger.Info("MCP backend identity was not available at startup", zap.Error(inspectErr))
		} else {
			cfg.MCPBackend = mcpBackend.Kind
			if mcpBackend.Kind == config.MCPBackendMockERP {
				if strings.EqualFold(strings.TrimSpace(cfg.Environment), "production") {
					zapLogger.Fatal("production refuses the standalone mock ERP", zap.String("mcp_base_url", cfg.MCPBaseURL))
				}
				zapLogger.Warn("DEMO MODE: executions are connected to the standalone mock ERP",
					zap.String("mcp_base_url", cfg.MCPBaseURL),
					zap.Int("tool_count", mcpBackend.ToolCount),
				)
			}
		}
	}
	runtimeRegistry, err := config.EnsureRuntimeRegistries(cfg)
	if err != nil {
		zapLogger.Fatal("initialize runtime registries", zap.Error(err))
	}
	zapLogger.Info("active runtime registry",
		zap.String("tool_path", runtimeRegistry.ToolPath),
		zap.String("tool_sha256", runtimeRegistry.ToolSHA256),
		zap.String("rule_path", runtimeRegistry.RulePath),
		zap.String("rule_sha256", runtimeRegistry.RuleSHA256),
		zap.Bool("writable", runtimeRegistry.Writable),
	)

	_ = config.NewRedisCache(cfg, zapLogger)

	storageContext, cancelStorage := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancelStorage()
	var stateCodec storage.Codec
	if cfg.StorageDriver == "postgres" {
		stateCodec, err = storage.NewAESGCMCodec(cfg.StorageEncryptionKey)
		if err != nil {
			zapLogger.Fatal("invalid PostgreSQL storage encryption configuration", zap.Error(err))
		}
	}
	stateBackend, err := storage.Open(storageContext, cfg.StorageDriver, cfg.DatabaseURL)
	if err != nil {
		zapLogger.Fatal("initialize storage", zap.Error(err))
	}
	var store *repository.Store
	if stateBackend == nil {
		store = repository.NewStore()
	} else {
		store, err = repository.NewPersistentStore(storageContext, stateBackend, stateCodec, func(persistErr error) {
			zapLogger.Error("persist runtime state", zap.Error(persistErr))
		})
		if err != nil {
			stateBackend.Close()
			zapLogger.Fatal("restore encrypted runtime state", zap.Error(err))
		}
		defer store.Close()
	}
	zapLogger.Info("storage initialized", zap.String("driver", cfg.StorageDriver), zap.Bool("durable", stateBackend != nil))
	reconciledExecutions := handlers.ReconcileOrphanedRunningExecutions(store, time.Now().UTC())
	if reconciledExecutions > 0 {
		zapLogger.Warn("orphaned running executions marked failed after restart", zap.Int("count", reconciledExecutions))
	}
	bootstrapCreated, err := store.BootstrapPlatformAdmin(cfg.BootstrapAdminEmail, cfg.BootstrapAdminPassword)
	if err != nil {
		zapLogger.Fatal("bootstrap platform administrator", zap.Error(err))
	}
	if bootstrapCreated {
		zapLogger.Info("platform administrator bootstrapped", zap.String("email", cfg.BootstrapAdminEmail))
	} else {
		zapLogger.Info("platform administrator bootstrap skipped because users already exist")
	}

	repository.ApplyDevUserRole(store, cfg.DevUserRole)
	store.Mu.Lock()
	if store.Settings.General == nil {
		store.Settings.General = map[string]interface{}{}
	}
	if store.Settings.LLM == nil {
		store.Settings.LLM = map[string]interface{}{}
	}
	if store.Settings.RBAC == nil {
		store.Settings.RBAC = map[string]interface{}{}
	}
	store.Settings.General["appName"] = cfg.AppName
	store.Settings.General["environment"] = cfg.Environment
	store.Settings.General["frontendUrl"] = cfg.FrontendURL
	store.Settings.LLM["provider"] = cfg.WorkflowGenerationProvider
	store.Settings.LLM["model"] = cfg.GeminiModel
	store.Settings.LLM["semanticSearchMode"] = cfg.SemanticSearchMode
	store.Settings.LLM["semanticFallback"] = cfg.SemanticFallback
	store.Settings.LLM["mcpMode"] = cfg.MCPMode
	store.Settings.LLM["managedByEnvironment"] = true
	store.Settings.RBAC["publicRegistrationEnabled"] = cfg.AllowPublicRegistration
	store.Settings.RBAC["defaultRoleId"] = "role_client"
	store.Mu.Unlock()
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
	if err := mcp.SetMode(cfg.MCPMode); err != nil {
		zapLogger.Fatal("configure MCP transport", zap.Error(err))
	}
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
	backfilledWorkflows, err := relevance.BackfillWorkflowDomainTags(store, handler.RegistryManager.Tools())
	if err != nil {
		zapLogger.Fatal("backfill workflow domain tags", zap.Error(err))
	}
	zapLogger.Info("workflow domain-tag backfill complete", zap.Int("workflows_updated", backfilledWorkflows))
	contextDocument, err := handler.RegistryContext.Regenerate()
	if err != nil {
		zapLogger.Fatal("generate runtime registry context", zap.Error(err))
	}
	zapLogger.Info("runtime registry generation context ready",
		zap.String("registry_hash", contextDocument.FrontMatter.RegistryHash),
		zap.Int("size_bytes", contextDocument.SizeBytes),
	)
	handler.RegistryManager.SetToolUpsert(func(toolDef coreregistry.Tool) {
		if !registry.Has(toolDef.Name) {
			registry.Register(tools.GenericMCPTool{Action: toolDef.Name, Client: mcp})
		}
	})
	if cfg.SeedSampleData {
		preview, seedErr := handler.RegistryManager.LoadSeedPreview(cfg.SampleToolSeedPath, cfg.SampleRuleSeedPath)
		if seedErr != nil {
			zapLogger.Fatal("load isolated sample seed preview", zap.Error(seedErr))
		}
		zapLogger.Info("isolated sample seed preview loaded",
			zap.Int("tools_loaded", len(preview.Tools)),
			zap.Int("rules_loaded", len(preview.Rules)),
			zap.String("evaluated_registry_hash", preview.EvaluatedRegistryHash),
		)
	}

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
		AllowOrigins:     cfg.CORSOrigins(),
		AllowHeaders:     "Origin, Content-Type, Accept, Authorization",
		AllowMethods:     "GET,POST,PATCH,PUT,DELETE,OPTIONS",
		AllowCredentials: true,
	}))
	app.Use(middlewares.RequestLogger(zapLogger))
	app.Use(middlewares.PersistenceFailureGuard(store))

	routes.Register(app, handler)

	addr := cfg.Host + ":" + cfg.Port
	zapLogger.Info("agentic orchestrator backend listening", zap.String("addr", addr), zap.String("api", cfg.APIBasePath))
	if err := app.Listen(addr); err != nil {
		zapLogger.Fatal("server stopped", zap.Error(err))
	}
}
