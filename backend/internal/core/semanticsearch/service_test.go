package semanticsearch

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
)

func TestExternalEmbeddingFailureHonorsLexicalFallback(t *testing.T) {
	failures := map[string]func(t *testing.T) string{
		"unreachable": func(t *testing.T) string {
			t.Helper()
			server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
			url := server.URL
			server.Close()
			return url
		},
		"http_503": func(t *testing.T) string {
			t.Helper()
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.WriteHeader(http.StatusServiceUnavailable)
			}))
			t.Cleanup(server.Close)
			return server.URL
		},
	}

	for name, failingURL := range failures {
		t.Run(name, func(t *testing.T) {
			t.Run("fallback_disabled_returns_error", func(t *testing.T) {
				service := newFallbackTestService(failingURL(t), false)

				_, err := service.SearchContext(context.Background(), "look up customer", "Client", Options{})
				if err == nil {
					t.Fatal("expected external embedding failure when lexical fallback is disabled")
				}
			})

			t.Run("fallback_enabled_returns_lexical_results", func(t *testing.T) {
				service := newFallbackTestService(failingURL(t), true)

				result, err := service.SearchContext(context.Background(), "look up customer", "Client", Options{})
				if err != nil {
					t.Fatalf("expected lexical fallback, got error: %v", err)
				}
				if result.Method != "go_lexical" {
					t.Fatalf("method = %q, want go_lexical", result.Method)
				}
				if result.RetrievalMethod != "go_lexical" {
					t.Fatalf("retrieval_method = %q, want go_lexical", result.RetrievalMethod)
				}
				if len(result.Tools) != 1 || result.Tools[0].ToolID != "tool.customer_lookup" {
					t.Fatalf("expected lexical customer tool result, got %#v", result.Tools)
				}
				if len(result.Rules) != 1 || result.Rules[0].RuleID != "CUSTOMER-READ-001" {
					t.Fatalf("expected lexical customer rule result, got %#v", result.Rules)
				}
			})
		})
	}
}

func newFallbackTestService(externalURL string, allowFallback bool) *Service {
	bundle := &registry.Bundle{
		Tools: registry.NewToolRegistry([]registry.Tool{
			{
				ToolID:                    "tool.customer_lookup",
				Name:                      "customer_lookup",
				DisplayName:               "Customer Lookup",
				Description:               "Look up customer records",
				SemanticSearchDescription: "Find a customer account",
				AllowedRoles:              []string{"Client"},
			},
		}, "test-tools"),
		Rules: registry.NewRuleRegistry([]registry.Rule{
			{
				RuleID:         "CUSTOMER-READ-001",
				RuleName:       "Customer record read rule",
				Description:    "Controls customer lookup access",
				AppliesToTools: []string{"customer_lookup"},
				Enabled:        true,
			},
		}, "test-rules"),
	}

	return NewServiceFromDataset(bundle, "external_embedding", externalURL, allowFallback)
}
