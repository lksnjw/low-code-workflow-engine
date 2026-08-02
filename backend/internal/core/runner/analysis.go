package runner

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/structuredoutput"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

const (
	defaultAnalysisMaxInputItems = 200
	defaultAnalysisMaxInputChars = 20000
)

type analysisCacheEntry struct {
	output interface{}
}

// ErrDataEgressViolation is returned before any provider call. It stores only
// a bounded redaction of the offending value.
type ErrDataEgressViolation struct {
	StepIndex     int
	ParamKey      string
	RuleID        string
	RedactedValue string
}

func (e *ErrDataEgressViolation) Error() string {
	return fmt.Sprintf("data egress violation at step %d input %s rule %s (value %s)", e.StepIndex, e.ParamKey, e.RuleID, e.RedactedValue)
}

type analysisOutcome struct {
	output       interface{}
	inputTokens  int
	outputTokens int
	cached       bool
}

func (e *Executor) executeAnalysisStep(ctx context.Context, executionID string, blueprint models.WorkflowBlueprint, stepIndex int, manager *StateManager, token *models.ValidationToken, cache map[string]analysisCacheEntry) (analysisOutcome, error) {
	step := blueprint.Steps[stepIndex]
	resolved := manager.Resolve(map[string]interface{}{"input": step.Input})["input"]
	if containsTemplate(resolved) {
		return analysisOutcome{}, fmt.Errorf("analysis step %s input could not be resolved", step.ID)
	}
	inputJSON, err := json.Marshal(resolved)
	if err != nil {
		return analysisOutcome{}, fmt.Errorf("analysis step %s input could not be encoded", step.ID)
	}
	maxItems := step.MaxInputItems
	if maxItems == 0 {
		maxItems = defaultAnalysisMaxInputItems
	}
	maxChars := step.MaxInputChars
	if maxChars == 0 {
		maxChars = defaultAnalysisMaxInputChars
	}
	if collectionSize(resolved) > maxItems || utf8.RuneCount(inputJSON) > maxChars {
		return analysisOutcome{}, fmt.Errorf("input too large for analysis step %s", step.ID)
	}

	if violation := e.Validator.EvaluateAnalysisEgress("model_egress."+executionID, blueprint, stepIndex, resolved, token); violation != nil {
		return analysisOutcome{}, &ErrDataEgressViolation{
			StepIndex:     violation.StepIndex,
			ParamKey:      violation.ParamKey,
			RuleID:        violation.RuleID,
			RedactedValue: redactValue(violation.Value),
		}
	}
	if e.AnalysisProvider == nil {
		return analysisOutcome{}, fmt.Errorf("analysis step %s has no active provider", step.ID)
	}

	schemaJSON, err := json.Marshal(step.OutputSchema)
	if err != nil {
		return analysisOutcome{}, fmt.Errorf("analysis step %s output schema could not be encoded", step.ID)
	}
	model := e.AnalysisProvider.AnalysisModel()
	cacheKey := analysisCacheKey(step.Instruction, inputJSON, schemaJSON, model)
	if cached, ok := cache[cacheKey]; ok {
		return analysisOutcome{output: cached.output, cached: true}, nil
	}

	prompt := analysisPrompt(step.Instruction, inputJSON, schemaJSON, "")
	totalInputTokens, totalOutputTokens := 0, 0
	for attempt := 0; attempt < 2; attempt++ {
		response, providerErr := e.AnalysisProvider.GenerateAnalysis(ctx, prompt, model)
		if providerErr != nil {
			return analysisOutcome{}, fmt.Errorf("analysis step %s provider request failed", step.ID)
		}
		if response.Measured {
			totalInputTokens += response.InputTokens
			totalOutputTokens += response.OutputTokens
		}
		decoded, decodeErr := decodeStructuredOutput(response.Text)
		if decodeErr == nil {
			decodeErr = structuredoutput.Validate(decoded, step.OutputSchema)
		}
		if decodeErr == nil {
			cache[cacheKey] = analysisCacheEntry{output: decoded}
			return analysisOutcome{output: decoded, inputTokens: totalInputTokens, outputTokens: totalOutputTokens}, nil
		}
		if attempt == 0 {
			prompt = analysisPrompt(step.Instruction, inputJSON, schemaJSON, "Your previous output did not match the schema. Return one corrected JSON value only.")
		}
	}
	return analysisOutcome{}, fmt.Errorf("analysis step %s provider output failed schema validation after one retry", step.ID)
}

func analysisPrompt(instruction string, inputJSON, schemaJSON []byte, correction string) string {
	var builder strings.Builder
	builder.WriteString("SYSTEM: Return exactly one JSON value conforming to OUTPUT_SCHEMA. Return no prose or markdown.\n")
	if correction != "" {
		builder.WriteString("CORRECTION: ")
		builder.WriteString(correction)
		builder.WriteByte('\n')
	}
	builder.WriteString("INSTRUCTION: ")
	builder.WriteString(instruction)
	builder.WriteString("\nOUTPUT_SCHEMA: ")
	builder.Write(schemaJSON)
	builder.WriteString("\nINPUT: ")
	builder.Write(inputJSON)
	return builder.String()
}

func analysisCacheKey(instruction string, inputJSON, schemaJSON []byte, model string) string {
	hash := sha256.New()
	_, _ = io.WriteString(hash, instruction)
	_, _ = hash.Write([]byte{0})
	_, _ = hash.Write(inputJSON)
	_, _ = hash.Write([]byte{0})
	_, _ = hash.Write(schemaJSON)
	_, _ = hash.Write([]byte{0})
	_, _ = io.WriteString(hash, model)
	return hex.EncodeToString(hash.Sum(nil))
}

func decodeStructuredOutput(raw string) (interface{}, error) {
	decoder := json.NewDecoder(bytes.NewBufferString(raw))
	decoder.UseNumber()
	var value interface{}
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var trailing interface{}
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, fmt.Errorf("multiple JSON values")
		}
		return nil, err
	}
	return value, nil
}

func collectionSize(value interface{}) int {
	switch typed := value.(type) {
	case []interface{}:
		return len(typed)
	case map[string]interface{}:
		return len(typed)
	default:
		return 1
	}
}

func containsTemplate(value interface{}) bool {
	switch typed := value.(type) {
	case string:
		return strings.Contains(typed, "{{") && strings.Contains(typed, "}}")
	case []interface{}:
		for _, item := range typed {
			if containsTemplate(item) {
				return true
			}
		}
	case map[string]interface{}:
		for _, item := range typed {
			if containsTemplate(item) {
				return true
			}
		}
	}
	return false
}
