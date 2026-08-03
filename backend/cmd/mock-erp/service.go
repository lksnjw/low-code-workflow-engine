package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
)

const maxRequestBytes = 1 << 20

type mockERPService struct {
	mu             sync.RWMutex
	seed           fixtureState
	state          fixtureState
	toolsByAction  map[string]coreregistry.Tool
	canonicalNames []string
	config         mockERPConfig
	requests       []RequestRecord
	logger         *log.Logger
}

func newMockERPService(tools []coreregistry.Tool, config mockERPConfig, logger *log.Logger) (*mockERPService, error) {
	seed, err := loadFixtureState()
	if err != nil {
		return nil, err
	}
	if logger == nil {
		logger = log.Default()
	}
	service := &mockERPService{
		seed:          cloneFixtureState(seed),
		state:         cloneFixtureState(seed),
		toolsByAction: map[string]coreregistry.Tool{},
		config:        config,
		requests:      []RequestRecord{},
		logger:        logger,
	}
	names := map[string]bool{}
	for _, tool := range tools {
		if !strings.EqualFold(strings.TrimSpace(tool.Status), "active_mcp_schema_present") {
			continue
		}
		name := strings.TrimSpace(tool.Name)
		if name == "" {
			continue
		}
		service.toolsByAction[normalizeAction(name)] = tool
		if alias := strings.TrimSpace(tool.MCPToolName); alias != "" {
			service.toolsByAction[normalizeAction(alias)] = tool
		}
		names[name] = true
	}
	for name := range names {
		service.canonicalNames = append(service.canonicalNames, name)
	}
	sort.Strings(service.canonicalNames)
	return service, nil
}

func (s *mockERPService) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/healthz":
		s.writeJSON(w, http.StatusOK, map[string]interface{}{
			"service":   "mock-erp",
			"status":    "healthy",
			"toolCount": len(s.canonicalNames),
			"tools":     append([]string{}, s.canonicalNames...),
		})
	case r.Method == http.MethodPost && r.URL.Path == "/reset":
		s.reset()
		s.writeJSON(w, http.StatusOK, map[string]interface{}{
			"reset":     true,
			"toolCount": len(s.canonicalNames),
		})
	case r.Method == http.MethodPost && r.URL.Path == "/tools/execute":
		s.handleExecute(w, r)
	default:
		s.writeFailure(w, http.StatusNotFound, "NOT_FOUND", "route not found")
	}
}

func (s *mockERPService) handleExecute(w http.ResponseWriter, r *http.Request) {
	if mediaType := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0])); mediaType != "application/json" {
		s.writeFailure(w, http.StatusBadRequest, "INVALID_REQUEST", "Content-Type must be application/json")
		return
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxRequestBytes))
	decoder.DisallowUnknownFields()
	var request executeRequest
	if err := decoder.Decode(&request); err != nil {
		s.writeFailure(w, http.StatusBadRequest, "INVALID_REQUEST", "request body must match the MCP execution contract")
		return
	}
	if strings.TrimSpace(request.Action) == "" {
		s.writeFailure(w, http.StatusBadRequest, "INVALID_REQUEST", "action is required")
		return
	}
	if request.Parameters == nil {
		request.Parameters = map[string]interface{}{}
	}
	tool, ok := s.toolsByAction[normalizeAction(request.Action)]
	if !ok {
		s.record(request.Action, "", request.Parameters, http.StatusNotFound, "NOT_FOUND")
		s.writeFailure(w, http.StatusNotFound, "NOT_FOUND", "tool is not served by this registry snapshot")
		return
	}
	if rawAlias, ok := request.Parameters["_action"]; ok {
		alias, valid := rawAlias.(string)
		aliasedTool, aliasKnown := s.toolsByAction[normalizeAction(alias)]
		if !valid || !aliasKnown || !strings.EqualFold(aliasedTool.Name, tool.Name) {
			s.record(request.Action, tool.Name, request.Parameters, http.StatusBadRequest, "INVALID_REQUEST")
			s.writeFailure(w, http.StatusBadRequest, "INVALID_REQUEST", "_action must identify the same registry tool")
			return
		}
	}
	if validationErrors := validateToolParameters(tool, request.Parameters); len(validationErrors) > 0 {
		s.record(request.Action, tool.Name, request.Parameters, http.StatusBadRequest, "INVALID_REQUEST")
		s.writeJSON(w, http.StatusBadRequest, map[string]interface{}{
			"error": map[string]interface{}{
				"category": "INVALID_REQUEST",
				"message":  "parameters do not satisfy the registry input schema",
				"fields":   validationErrors,
			},
		})
		return
	}

	s.waitForTool(tool.Name)
	if status, category, injected := s.injectedFailure(tool, request.Action); injected {
		s.record(request.Action, tool.Name, request.Parameters, status, category)
		s.writeFailure(w, status, category, "injected mock ERP failure")
		return
	}

	result, executeErr := s.execute(tool, request.Parameters)
	if executeErr != nil {
		s.record(request.Action, tool.Name, request.Parameters, executeErr.Status, executeErr.Category)
		s.writeFailure(w, executeErr.Status, executeErr.Category, executeErr.Message)
		return
	}
	s.record(request.Action, tool.Name, request.Parameters, http.StatusOK, "SUCCESS")
	s.writeJSON(w, http.StatusOK, result)
}

func (s *mockERPService) injectedFailure(tool coreregistry.Tool, requestedAction string) (int, string, bool) {
	failTool := normalizeAction(s.config.FailTool)
	if failTool == "" {
		return 0, "", false
	}
	alias := normalizeAction(tool.MCPToolName)
	if failTool != normalizeAction(tool.Name) && failTool != alias && failTool != normalizeAction(requestedAction) {
		return 0, "", false
	}
	switch strings.ToLower(strings.TrimSpace(s.config.FailMode)) {
	case "invalid":
		return http.StatusBadRequest, "INVALID_REQUEST", true
	case "auth":
		return http.StatusUnauthorized, "AUTH_DENIED", true
	case "notfound":
		return http.StatusNotFound, "NOT_FOUND", true
	case "transient":
		return http.StatusServiceUnavailable, "TRANSIENT", true
	default:
		return 0, "", false
	}
}

func (s *mockERPService) waitForTool(action string) {
	minimum := s.config.MinLatency
	maximum := s.config.MaxLatency
	if minimum < 0 {
		minimum = 0
	}
	if maximum < minimum {
		maximum = minimum
	}
	delay := minimum
	if span := maximum - minimum; span > 0 {
		sum := sha256.Sum256([]byte(normalizeAction(action)))
		value := int(sum[0])<<8 | int(sum[1])
		spanMilliseconds := int(span / time.Millisecond)
		if spanMilliseconds > 0 {
			delay += time.Duration(value%(spanMilliseconds+1)) * time.Millisecond
		}
	}
	if delay > 0 {
		time.Sleep(delay)
	}
}

func (s *mockERPService) reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state = cloneFixtureState(s.seed)
	s.requests = []RequestRecord{}
}

func (s *mockERPService) Requests() []RequestRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]RequestRecord, len(s.requests))
	copy(out, s.requests)
	return out
}

func (s *mockERPService) record(action, canonical string, parameters map[string]interface{}, status int, outcome string) {
	s.mu.Lock()
	record := RequestRecord{
		Sequence:        len(s.requests) + 1,
		Timestamp:       time.Now().UTC(),
		Action:          action,
		CanonicalAction: canonical,
		Parameters:      cloneMapWithoutAction(parameters),
		StatusCode:      status,
		Outcome:         outcome,
	}
	s.requests = append(s.requests, record)
	s.mu.Unlock()
	raw, _ := json.Marshal(record)
	s.logger.Printf("request %s", raw)
}

func (s *mockERPService) writeFailure(w http.ResponseWriter, status int, category, message string) {
	s.writeJSON(w, status, map[string]interface{}{
		"error": map[string]interface{}{
			"category": category,
			"message":  message,
		},
	})
}

func (s *mockERPService) writeJSON(w http.ResponseWriter, status int, payload map[string]interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func normalizeAction(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func deterministicID(prefix, action string, parameters map[string]interface{}) string {
	canonical, _ := json.Marshal(cloneMapWithoutAction(parameters))
	sum := sha256.Sum256(append([]byte(normalizeAction(action)+"\x00"), canonical...))
	return strings.ToUpper(prefix) + "-" + strings.ToUpper(hex.EncodeToString(sum[:6]))
}

func cloneMapWithoutAction(input map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	for key, value := range input {
		if key == "_action" {
			continue
		}
		out[key] = value
	}
	return out
}

func cloneFixtureState(input fixtureState) fixtureState {
	raw, err := json.Marshal(input)
	if err != nil {
		panic(fmt.Sprintf("clone fixture state: %v", err))
	}
	var out fixtureState
	if err := json.Unmarshal(raw, &out); err != nil {
		panic(fmt.Sprintf("clone fixture state: %v", err))
	}
	return out
}
