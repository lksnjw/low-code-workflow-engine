package main

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strings"

	coreregistry "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
)

func validateToolParameters(tool coreregistry.Tool, params map[string]interface{}) []string {
	errorsFound := []string{}
	required := map[string]bool{}
	for _, name := range tool.RequiredParameters {
		required[name] = true
	}
	if raw, ok := tool.InputSchema["required"].([]interface{}); ok {
		for _, item := range raw {
			if name, ok := item.(string); ok {
				required[name] = true
			}
		}
	}
	if raw, ok := tool.InputSchema["required"].([]string); ok {
		for _, name := range raw {
			required[name] = true
		}
	}
	names := make([]string, 0, len(required))
	for name := range required {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		value, exists := params[name]
		if !exists || value == nil || (reflect.ValueOf(value).Kind() == reflect.String && strings.TrimSpace(fmt.Sprint(value)) == "") {
			errorsFound = append(errorsFound, "missing required parameter "+name)
		}
	}

	properties, _ := tool.InputSchema["properties"].(map[string]interface{})
	for name, definition := range properties {
		value, exists := params[name]
		if !exists || value == nil {
			continue
		}
		schema, _ := definition.(map[string]interface{})
		if expected, _ := schema["type"].(string); expected != "" && !matchesJSONType(value, expected) {
			errorsFound = append(errorsFound, fmt.Sprintf("parameter %s must be %s", name, expected))
			continue
		}
		if enum, ok := schema["enum"].([]interface{}); ok && !containsJSONValue(enum, value) {
			errorsFound = append(errorsFound, fmt.Sprintf("parameter %s is not an allowed value", name))
		}
		if number, ok := jsonNumber(value); ok {
			if minimum, ok := jsonNumber(schema["minimum"]); ok && number < minimum {
				errorsFound = append(errorsFound, fmt.Sprintf("parameter %s must be at least %v", name, minimum))
			}
			if maximum, ok := jsonNumber(schema["maximum"]); ok && number > maximum {
				errorsFound = append(errorsFound, fmt.Sprintf("parameter %s must be at most %v", name, maximum))
			}
		}
	}
	sort.Strings(errorsFound)
	return errorsFound
}

func matchesJSONType(value interface{}, expected string) bool {
	switch strings.ToLower(expected) {
	case "string":
		_, ok := value.(string)
		return ok
	case "number":
		_, ok := jsonNumber(value)
		return ok
	case "integer":
		number, ok := jsonNumber(value)
		return ok && math.Trunc(number) == number
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "array":
		kind := reflect.ValueOf(value).Kind()
		return kind == reflect.Array || kind == reflect.Slice
	case "object":
		_, ok := value.(map[string]interface{})
		return ok
	default:
		return false
	}
}

func containsJSONValue(values []interface{}, target interface{}) bool {
	for _, value := range values {
		if reflect.DeepEqual(value, target) || fmt.Sprint(value) == fmt.Sprint(target) {
			return true
		}
	}
	return false
}

func jsonNumber(value interface{}) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case int32:
		return float64(typed), true
	case json.Number:
		number, err := typed.Float64()
		return number, err == nil
	default:
		return 0, false
	}
}
