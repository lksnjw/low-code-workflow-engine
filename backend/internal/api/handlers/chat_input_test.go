package handlers

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func TestSendChatMessageRejectsMalformedJSONWithClearBadRequest(t *testing.T) {
	handler := &Handler{}
	app := fiber.New()
	app.Post("/chat/sessions/:id/messages", handler.SendChatMessage)

	request := httptest.NewRequest(http.MethodPost, "/chat/sessions/session-1/messages", strings.NewReader(`{"content":`))
	request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("SendChatMessage request failed: %v", err)
	}
	defer response.Body.Close()

	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read SendChatMessage response: %v", err)
	}
	if response.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("SendChatMessage returned %d, want 400: %s", response.StatusCode, body)
	}
	if !strings.Contains(string(body), "Invalid JSON request body") {
		t.Fatalf("SendChatMessage response did not explain the malformed JSON: %s", body)
	}
}
