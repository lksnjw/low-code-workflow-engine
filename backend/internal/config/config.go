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
	AppName      string
	Environment  string
	Host         string
	Port         string
	APIBasePath  string
	FrontendURL  string
	JWTSecret    string
	TokenTTL     time.Duration
	AllowDevAuth bool
	DevUserRole  string

	DatabaseURL string
	RedisURL    string

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
		Host:                               getEnv("APP_HOST", "0.0.0.0"),
		Port:                               getEnv("APP_PORT", "8080"),
		APIBasePath:                        getEnv("API_BASE_PATH", "/api"),
		FrontendURL:                        getEnv("FRONTEND_URL", "http://127.0.0.1:5173"),
		JWTSecret:                          getEnv("JWT_SECRET", "local-development-secret-change-me"),
		TokenTTL:                           time.Duration(getEnvInt("JWT_EXPIRES_MINUTES", 60)) * time.Minute,
		AllowDevAuth:                       getEnvBool("ALLOW_DEV_AUTH", false),
		DevUserRole:                        devUserRole,
		DatabaseURL:                        getEnv("DATABASE_URL", "postgres://workflow:workflow@localhost:5432/workflow?sslmode=disable"),
		RedisURL:                           getEnv("REDIS_URL", "redis://localhost:6379/0"),
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
		GeminiModel:                        getEnv("GEMINI_MODEL", "gemini-1.5-flash"),
		CandidateCount:                     getEnvInt("CANDIDATE_COUNT", 5),
		ChatTraceBoxes:                     getEnvBool("CHAT_TRACE_BOXES", strings.EqualFold(environment, "development")),
		ChatUserRoleOverride:               getEnv("CHAT_USER_ROLE_OVERRIDE", devUserRole),
		ExperimentBaseline:                 getEnv("EXPERIMENT_BASELINE", ""),
	}
}

// Validate rejects unsafe or unknown experiment modes before the server starts.
func (c Config) Validate() error {
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
	return nil
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
