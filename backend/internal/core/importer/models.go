package importer

import (
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
)

type SourceKind string

const (
	SourceTools   SourceKind = "tools"
	SourceRules   SourceKind = "rules"
	SourceOpenAPI SourceKind = "openapi"
)

type StageName string

const (
	StageParse     StageName = "PARSE"
	StageNormalise StageName = "NORMALISE"
	StageValidate  StageName = "VALIDATE"
	StageDiff      StageName = "DIFF"
	StageConfirm   StageName = "CONFIRM"
	StageCommit    StageName = "COMMIT"
)

type StageResult struct {
	Name   StageName `json:"name"`
	Status string    `json:"status"`
}

type RecordError struct {
	RecordID string `json:"recordId,omitempty"`
	Line     int    `json:"line,omitempty"`
	Index    int    `json:"index"`
	Field    string `json:"field"`
	Reason   string `json:"reason"`
}

type FieldChange struct {
	Field  string      `json:"field"`
	Before interface{} `json:"before"`
	After  interface{} `json:"after"`
}

type ImportRecord struct {
	RecordID             string                 `json:"recordId"`
	RegistryKind         SourceKind             `json:"registryKind"`
	SourceID             string                 `json:"sourceId"`
	Line                 int                    `json:"line,omitempty"`
	Index                int                    `json:"index"`
	Category             string                 `json:"category"`
	Tool                 *registry.Tool         `json:"tool,omitempty"`
	Rule                 *registry.Rule         `json:"rule,omitempty"`
	Changes              []FieldChange          `json:"changes"`
	Errors               []RecordError          `json:"errors"`
	Metadata             map[string]interface{} `json:"metadata,omitempty"`
	RequiresConfirmation bool                   `json:"requiresConfirmation"`
}

type Preview struct {
	Added     []ImportRecord `json:"added"`
	Updated   []ImportRecord `json:"updated"`
	Unchanged []ImportRecord `json:"unchanged"`
	Rejected  []ImportRecord `json:"rejected"`
	Orphaned  []ImportRecord `json:"orphaned"`
}

type AnalyseInput struct {
	Filename     string
	Content      []byte
	Kind         SourceKind
	Prefix       string
	AllowUpdates bool
}

type Analysis struct {
	ID           string        `json:"id"`
	Filename     string        `json:"filename"`
	FileSHA256   string        `json:"fileSha256"`
	Kind         SourceKind    `json:"kind"`
	AllowUpdates bool          `json:"allowUpdates"`
	Stages       []StageResult `json:"stages"`
	Preview      Preview       `json:"preview"`
	CreatedAt    time.Time     `json:"createdAt"`
}

type CommitOptions struct {
	SelectedRecordIDs []string
	ActorID           string
	ActorName         string
}

type CommitResult struct {
	AnalysisID        string         `json:"analysisId"`
	Filename          string         `json:"filename"`
	FileSHA256        string         `json:"fileSha256"`
	ResultingHash     string         `json:"resultingRegistryHash"`
	CommittedRecordID []string       `json:"committedRecordIds"`
	Counts            map[string]int `json:"counts"`
	CommittedAt       time.Time      `json:"committedAt"`
}

type HistoryEntry struct {
	AnalysisID      string                 `json:"analysisId"`
	ActorID         string                 `json:"actorId"`
	ActorName       string                 `json:"actorName"`
	Filename        string                 `json:"filename"`
	FileSHA256      string                 `json:"fileSha256"`
	Counts          map[string]int         `json:"counts"`
	Diff            Preview                `json:"diff"`
	ResponseSchemas map[string]interface{} `json:"responseSchemas"`
	ResultingHash   string                 `json:"resultingRegistryHash"`
	CommittedAt     time.Time              `json:"committedAt"`
}

func emptyPreview() Preview {
	return Preview{
		Added:     []ImportRecord{},
		Updated:   []ImportRecord{},
		Unchanged: []ImportRecord{},
		Rejected:  []ImportRecord{},
		Orphaned:  []ImportRecord{},
	}
}
