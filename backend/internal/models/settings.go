package models

import "time"

type SettingsBundle struct {
	General map[string]interface{} `json:"general"`
	LLM     map[string]interface{} `json:"llm"`
	RBAC    map[string]interface{} `json:"rbac"`
}

type ProviderConfig struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Type      string    `json:"type"`
	BaseURL   string    `json:"baseUrl,omitempty"`
	Model     string    `json:"model"`
	APIKey    string    `json:"-"`
	Active    bool      `json:"active"`
	CreatedAt time.Time `json:"createdAt"`
}

type Integration struct {
	ID           string                 `json:"id"`
	Name         string                 `json:"name"`
	Type         string                 `json:"type"`
	Status       string                 `json:"status"`
	Icon         string                 `json:"icon"`
	Config       map[string]interface{} `json:"config"`
	LastTestedAt *time.Time             `json:"lastTestedAt"`
	CreatedAt    time.Time              `json:"createdAt"`
}

type Webhook struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	URL           string    `json:"url"`
	Events        []string  `json:"events"`
	Enabled       bool      `json:"enabled"`
	SecretPreview string    `json:"secretPreview"`
	CreatedAt     time.Time `json:"createdAt"`
}

type ChatSession struct {
	ID           string    `json:"id"`
	OwnerID      string    `json:"ownerId"`
	Title        string    `json:"title"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
	MessageCount int       `json:"messageCount"`
}

type ChatMessage struct {
	ID        string                 `json:"id"`
	Role      string                 `json:"role"`
	Text      string                 `json:"text"`
	Artifacts map[string]interface{} `json:"artifacts,omitempty"`
	CreatedAt time.Time              `json:"createdAt"`
}

type ChatSessionDetail struct {
	ChatSession
	Messages []ChatMessage `json:"messages"`
}
