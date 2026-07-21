package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	AppName     string
	Environment string
	Host        string
	Port        string
	APIBasePath string
	FrontendURL string
	JWTSecret   string
	TokenTTL    time.Duration
	DevUserRole string

	AllowPublicRegistration bool
	BootstrapAdminToken     string

	DatabaseURL string
	RedisURL    string
	// StorageDriver selects process-local memory or encrypted PostgreSQL state.
	StorageDriver        string
	StorageEncryptionKey string

	OllamaBaseURL string
	OllamaModel   string
	OllamaEnabled bool

	MCPBaseURL string
	MCPTimeout time.Duration
	MCPMode    string

	DatasetRoot                        string
	ToolRegistryPath                   string
	RuleRegistryPath                   string
	SemanticSearchMode                 string
	SemanticSearchURL                  string
	SemanticSearchTopKTools            int
	SemanticSearchTopKRules            int
	SemanticSearchTopKTemplates        int
	SemanticSearchTopKExamples         int
	SemanticSearchAllowLexicalFallback bool
	SemanticFallback                   string
	WorkflowGenerationProvider         string
	GeminiAPIKey                       string
	GeminiModel                        string
	CandidateCount                     int
	ChatTraceBoxes                     bool
	ChatUserRoleOverride               string
	ExperimentBaseline                 string
}

func Load() Config {
	_ = godotenv.Load(
		".env.local",
		".env.development",
		".env",
		"backend/.env.local",
		"backend/.env.development",
		"backend/.env",
	)
	environment := getEnv("APP_ENV", "development")
	isProduction := strings.EqualFold(strings.TrimSpace(environment), "production")
	backendRoot := detectBackendRoot()
	datasetRoot := resolveAppPath(getEnv("DATASET_ROOT", "./dataset"), backendRoot)
	toolRegistryPath := resolveAppPath(
		getEnv("TOOL_REGISTRY_PATH", "./configs/registries/all_tools_master_registry.json"),
		backendRoot,
	)
	ruleRegistryPath := resolveAppPath(
		getEnv("RULE_REGISTRY_PATH", "./configs/registries/all_rules_master_registry.json"),
		backendRoot,
	)
	devUserRole := getEnv("DEV_USER_ROLE", "")
	mcpMode := strings.ToLower(strings.TrimSpace(getEnv("MCP_MODE", "remote")))
	semanticFallback := strings.ToLower(strings.TrimSpace(getEnv("SEMANTIC_FALLBACK", "")))
	if semanticFallback == "" {
		if getEnvBool("SEMANTIC_SEARCH_ALLOW_LEXICAL_FALLBACK", false) {
			semanticFallback = "lexical"
		} else {
			semanticFallback = "off"
		}
	}

	return Config{
		AppName:                            getEnv("APP_NAME", "Agentic Workflow Engine"),
		Environment:                        environment,
		Host:                               getEnv("APP_HOST", "127.0.0.1"),
		Port:                               getEnv("APP_PORT", "8080"),
		APIBasePath:                        getEnv("API_BASE_PATH", "/api"),
		FrontendURL:                        getEnv("FRONTEND_URL", "http://127.0.0.1:5173"),
		JWTSecret:                          getEnv("JWT_SECRET", "local-development-secret-change-me"),
		TokenTTL:                           time.Duration(getEnvInt("JWT_EXPIRES_MINUTES", 60)) * time.Minute,
		DevUserRole:                        devUserRole,
		AllowPublicRegistration:            getEnvBool("ALLOW_PUBLIC_REGISTRATION", !isProduction),
		BootstrapAdminToken:                getEnv("BOOTSTRAP_ADMIN_TOKEN", ""),
		DatabaseURL:                        getEnv("DATABASE_URL", "postgres://workflow:workflow@localhost:5432/workflow?sslmode=disable"),
		RedisURL:                           getEnv("REDIS_URL", "redis://localhost:6379/0"),
		StorageDriver:                      strings.ToLower(strings.TrimSpace(getEnv("STORAGE_DRIVER", "memory"))),
		StorageEncryptionKey:               getEnv("STORAGE_ENCRYPTION_KEY", ""),
		OllamaBaseURL:                      strings.TrimRight(getEnv("OLLAMA_BASE_URL", "http://localhost:11434"), "/"),
		OllamaModel:                        getEnv("OLLAMA_MODEL", "phi3:mini"),
		OllamaEnabled:                      getEnvBool("OLLAMA_ENABLED", false),
		MCPBaseURL:                         strings.TrimRight(getEnv("MCP_BASE_URL", ""), "/"),
		MCPTimeout:                         time.Duration(getEnvInt("MCP_TIMEOUT_SECONDS", 15)) * time.Second,
		MCPMode:                            mcpMode,
		DatasetRoot:                        datasetRoot,
		ToolRegistryPath:                   toolRegistryPath,
		RuleRegistryPath:                   ruleRegistryPath,
		SemanticSearchMode:                 getEnv("SEMANTIC_SEARCH_MODE", "external_embedding"),
		SemanticSearchURL:                  strings.TrimRight(getEnv("SEMANTIC_SEARCH_URL", "http://localhost:8090/search"), "/"),
		SemanticSearchTopKTools:            getEnvInt("SEMANTIC_SEARCH_TOP_K_TOOLS", 10),
		SemanticSearchTopKRules:            getEnvInt("SEMANTIC_SEARCH_TOP_K_RULES", 15),
		SemanticSearchTopKTemplates:        getEnvInt("SEMANTIC_SEARCH_TOP_K_TEMPLATES", 5),
		SemanticSearchTopKExamples:         getEnvInt("SEMANTIC_SEARCH_TOP_K_EXAMPLES", 5),
		SemanticSearchAllowLexicalFallback: semanticFallback == "lexical",
		SemanticFallback:                   semanticFallback,
		WorkflowGenerationProvider:         getEnv("WORKFLOW_GENERATION_PROVIDER", "gemini"),
		GeminiAPIKey:                       getEnv("GEMINI_API_KEY", ""),
		GeminiModel:                        getEnv("GEMINI_MODEL", "gemini-2.5-flash"),
		CandidateCount:                     getEnvInt("CANDIDATE_COUNT", 5),
		ChatTraceBoxes:                     getEnvBool("CHAT_TRACE_BOXES", strings.EqualFold(environment, "development")),
		ChatUserRoleOverride:               getEnv("CHAT_USER_ROLE_OVERRIDE", devUserRole),
		ExperimentBaseline:                 getEnv("EXPERIMENT_BASELINE", ""),
	}
}

// Validate rejects unsafe or unknown experiment modes before the server starts.
func (c Config) Validate() error {
	switch strings.ToLower(strings.TrimSpace(c.StorageDriver)) {
	case "", "memory":
	case "postgres":
		if strings.TrimSpace(c.DatabaseURL) == "" {
			return fmt.Errorf("DATABASE_URL is required when STORAGE_DRIVER=postgres")
		}
		if strings.TrimSpace(c.StorageEncryptionKey) == "" {
			return fmt.Errorf("STORAGE_ENCRYPTION_KEY is required when STORAGE_DRIVER=postgres")
		}
	default:
		return fmt.Errorf("unsupported STORAGE_DRIVER %q (allowed values: memory or postgres)", c.StorageDriver)
	}
	switch c.ExperimentBaseline {
	case "":
	case "B":
		if c.Environment != "experiment" {
			return fmt.Errorf("EXPERIMENT_BASELINE=B requires APP_ENV=experiment")
		}
	default:
		return fmt.Errorf("unsupported EXPERIMENT_BASELINE %q (allowed values: unset or B)", c.ExperimentBaseline)
	}
	switch strings.ToLower(strings.TrimSpace(c.MCPMode)) {
	case "", "remote", "mock":
	default:
		return fmt.Errorf("unsupported MCP_MODE %q (allowed values: remote or mock)", c.MCPMode)
	}
	switch strings.ToLower(strings.TrimSpace(c.SemanticFallback)) {
	case "", "off", "lexical":
	default:
		return fmt.Errorf("unsupported SEMANTIC_FALLBACK %q (allowed values: off or lexical)", c.SemanticFallback)
	}
	if strings.EqualFold(strings.TrimSpace(c.Environment), "production") {
		jwtSecret := strings.TrimSpace(c.JWTSecret)
		if len([]byte(jwtSecret)) < 32 || jwtSecret == "local-development-secret-change-me" || jwtSecret == "change-me-before-production" {
			return fmt.Errorf("JWT_SECRET must be a unique secret of at least 32 bytes when APP_ENV=production")
		}
		if len([]byte(strings.TrimSpace(c.BootstrapAdminToken))) < 32 {
			return fmt.Errorf("BOOTSTRAP_ADMIN_TOKEN must be a unique secret of at least 32 bytes when APP_ENV=production")
		}
		if c.AllowPublicRegistration {
			return fmt.Errorf("ALLOW_PUBLIC_REGISTRATION must be false when APP_ENV=production")
		}
		if strings.EqualFold(strings.TrimSpace(c.MCPMode), "mock") {
			return fmt.Errorf("MCP_MODE=mock is not allowed when APP_ENV=production")
		}
		if !strings.EqualFold(strings.TrimSpace(c.StorageDriver), "postgres") {
			return fmt.Errorf("STORAGE_DRIVER must be postgres when APP_ENV=production")
		}
	}
	return nil
}

// CORSOrigins returns the explicit browser origins accepted by the API. Local
// development aliases are never added to a production deployment.
func (c Config) CORSOrigins() string {
	origins := []string{}
	seen := map[string]struct{}{}
	add := func(origin string) {
		origin = strings.TrimSpace(origin)
		if origin == "" {
			return
		}
		if _, exists := seen[origin]; exists {
			return
		}
		seen[origin] = struct{}{}
		origins = append(origins, origin)
	}

	add(c.FrontendURL)
	if !strings.EqualFold(strings.TrimSpace(c.Environment), "production") {
		add("http://localhost:5173")
		add("http://127.0.0.1:5173")
	}
	return strings.Join(origins, ",")
}

func (c Config) BaselineBEnabled() bool {
	return c.Environment == "experiment" && c.ExperimentBaseline == "B"
}

func detectBackendRoot() string {
	candidates := []string{".", "./backend"}
	for _, candidate := range candidates {
		registryPath := filepath.Join(candidate, "configs", "registries", "all_tools_master_registry.json")
		if _, err := os.Stat(registryPath); err == nil {
			return candidate
		}
	}

	return "."
}

func resolveAppPath(value string, backendRoot string) string {
	if strings.TrimSpace(value) == "" || filepath.IsAbs(value) {
		return value
	}

	if _, err := os.Stat(value); err == nil {
		return value
	}

	backendRelative := filepath.Join(backendRoot, value)
	if _, err := os.Stat(backendRelative); err == nil {
		return backendRelative
	}

	return value
}

func getEnv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}

	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}

	return parsed
}

func getEnvBool(key string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}

	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}

	return parsed
}
