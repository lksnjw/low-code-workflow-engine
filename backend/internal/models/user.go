package models

import "time"

type RoleRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type User struct {
	ID               string     `json:"id"`
	Name             string     `json:"name"`
	Email            string     `json:"email"`
	Role             RoleRef    `json:"role"`
	Permissions      []string   `json:"permissions"`
	Status           string     `json:"status"`
	Initials         string     `json:"initials"`
	Timezone         string     `json:"timezone,omitempty"`
	LastLoginAt      *time.Time `json:"lastLoginAt"`
	CreatedAt        time.Time  `json:"createdAt"`
	TwoFactorEnabled bool       `json:"twoFactorEnabled,omitempty"`
	EmailVerified    bool       `json:"emailVerified,omitempty"`
}

type Role struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Permissions []string  `json:"permissions"`
	CreatedAt   time.Time `json:"createdAt"`
}

type Permission struct {
	Key         string `json:"key"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Group       string `json:"group"`
}

type AuditLog struct {
	ID        string                 `json:"id"`
	Actor     Principal              `json:"actor"`
	Action    string                 `json:"action"`
	Resource  ResourceRef            `json:"resource"`
	IPAddress string                 `json:"ipAddress"`
	UserAgent string                 `json:"userAgent"`
	Before    map[string]interface{} `json:"before"`
	After     map[string]interface{} `json:"after"`
	CreatedAt time.Time              `json:"createdAt"`
}

type Profile struct {
	ID               string  `json:"id"`
	Name             string  `json:"name"`
	Email            string  `json:"email"`
	Role             string  `json:"role"`
	Timezone         string  `json:"timezone"`
	AvatarURL        *string `json:"avatarUrl"`
	TwoFactorEnabled bool    `json:"twoFactorEnabled"`
}

type NotificationPreferences struct {
	ExecutionFailures bool            `json:"executionFailures"`
	HealingEvents     bool            `json:"healingEvents"`
	BudgetWarnings    bool            `json:"budgetWarnings"`
	WeeklyReports     bool            `json:"weeklyReports"`
	Channels          map[string]bool `json:"channels"`
}

type APIKey struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Key       string     `json:"-"`
	MaskedKey string     `json:"maskedKey"`
	Scopes    []string   `json:"scopes"`
	CreatedAt time.Time  `json:"createdAt"`
	ExpiresAt *time.Time `json:"expiresAt"`
}

type Notification struct {
	ID        string                 `json:"id"`
	Message   string                 `json:"message"`
	Tone      string                 `json:"tone"`
	Type      string                 `json:"type"`
	Read      bool                   `json:"read"`
	Resource  map[string]interface{} `json:"resource"`
	CreatedAt time.Time              `json:"createdAt"`
}
