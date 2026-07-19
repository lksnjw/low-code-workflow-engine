package models

import "time"

const (
	StatusPending          = "PENDING"
	StatusRunning          = "RUNNING"
	StatusDone             = "DONE"
	StatusFailed           = "FAILED"
	StatusHealing          = "HEALING"
	StatusDraftUnvalidated = "draft-unvalidated"
)

type WorkflowBlueprint struct {
	Name        string                  `json:"name" yaml:"name" validate:"required"`
	Description string                  `json:"description,omitempty" yaml:"description,omitempty"`
	Trigger     BlueprintTrigger        `json:"trigger" yaml:"trigger" validate:"required"`
	Steps       []WorkflowStepBlueprint `json:"steps" yaml:"steps" validate:"required,min=1,dive"`
	Metadata    map[string]interface{}  `json:"metadata,omitempty" yaml:"metadata,omitempty"`
}

type BlueprintTrigger struct {
	Type        string                 `json:"type" yaml:"type" validate:"required"`
	DisplayName string                 `json:"displayName,omitempty" yaml:"displayName,omitempty"`
	Config      map[string]interface{} `json:"config,omitempty" yaml:"config,omitempty"`
}

type WorkflowStepBlueprint struct {
	ID          string                 `json:"id" yaml:"id" validate:"required"`
	Type        string                 `json:"type,omitempty" yaml:"type,omitempty"`
	Action      string                 `json:"action" yaml:"action" validate:"required"`
	Parameters  map[string]interface{} `json:"parameters,omitempty" yaml:"parameters,omitempty"`
	Condition   string                 `json:"condition,omitempty" yaml:"condition,omitempty"`
	OnError     string                 `json:"onError,omitempty" yaml:"onError,omitempty"`
	RetryCount  int                    `json:"retryCount,omitempty" yaml:"retryCount,omitempty"`
	Description string                 `json:"description,omitempty" yaml:"description,omitempty"`
}

type Workflow struct {
	ID               string                 `json:"id"`
	Name             string                 `json:"name"`
	Description      string                 `json:"description"`
	Owner            Principal              `json:"owner"`
	Status           string                 `json:"status"`
	Trigger          map[string]interface{} `json:"trigger"`
	Steps            int                    `json:"steps"`
	SuccessRate      float64                `json:"successRate"`
	LastRunAt        *time.Time             `json:"lastRunAt"`
	PublishedVersion int                    `json:"publishedVersion"`
	DraftVersion     int                    `json:"draftVersion"`
	Tags             []string               `json:"tags"`
	YAML             string                 `json:"-"`
	Canvas           WorkflowCanvas         `json:"-"`
	CreatedAt        time.Time              `json:"createdAt"`
	UpdatedAt        time.Time              `json:"updatedAt"`
	Archived         bool                   `json:"-"`
}

type WorkflowYAML struct {
	WorkflowID string    `json:"workflowId"`
	Version    int       `json:"version"`
	YAML       string    `json:"yaml"`
	Checksum   string    `json:"checksum"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type WorkflowCanvas struct {
	WorkflowID string                 `json:"workflowId"`
	Nodes      []WorkflowNode         `json:"nodes"`
	Edges      []WorkflowEdge         `json:"edges"`
	Viewport   map[string]interface{} `json:"viewport"`
}

type WorkflowNode struct {
	ID       string                 `json:"id"`
	Label    string                 `json:"label"`
	Type     string                 `json:"type"`
	Icon     string                 `json:"icon,omitempty"`
	Position map[string]float64     `json:"position"`
	Status   string                 `json:"status"`
	Config   map[string]interface{} `json:"config"`
}

type WorkflowEdge struct {
	ID     string  `json:"id"`
	Source string  `json:"source"`
	Target string  `json:"target"`
	Type   string  `json:"type"`
	Label  *string `json:"label"`
}

type WorkflowVersion struct {
	ID          string    `json:"id"`
	WorkflowID  string    `json:"workflowId"`
	Version     int       `json:"version"`
	VersionNote string    `json:"versionNote"`
	YAML        string    `json:"yaml,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	CreatedBy   Principal `json:"createdBy"`
}

type WorkflowTemplate struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Category    string    `json:"category"`
	Tags        []string  `json:"tags"`
	YAML        string    `json:"yaml"`
	Steps       int       `json:"steps"`
	CreatedAt   time.Time `json:"createdAt"`
}

type CreateWorkflowRequest struct {
	Name        string                 `json:"name" validate:"required"`
	Description string                 `json:"description"`
	OwnerID     string                 `json:"ownerId"`
	Trigger     map[string]interface{} `json:"trigger"`
	YAML        string                 `json:"yaml"`
	Tags        []string               `json:"tags"`
}

type UpdateWorkflowRequest struct {
	Name        *string                `json:"name"`
	Description *string                `json:"description"`
	Status      *string                `json:"status"`
	Trigger     map[string]interface{} `json:"trigger"`
	Tags        []string               `json:"tags"`
}
