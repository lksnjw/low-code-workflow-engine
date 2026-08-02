package structuredoutput

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strings"
)

var supportedTypes = map[string]bool{
	"array": true, "boolean": true, "integer": true, "null": true,
	"number": true, "object": true, "string": true,
}

var supportedKeywords = map[string]bool{
	"additionalProperties": true,
	"description":          true,
	"enum":                 true,
	"items":                true,
	"properties":           true,
	"required":             true,
	"title":                true,
	"type":                 true,
}

// ValidateSchema accepts the bounded JSON-schema subset used by analysis
// steps. The root must describe structured JSON, never free text.
func ValidateSchema(schema map[string]interface{}) error {
	if len(schema) == 0 {
		return fmt.Errorf("output_schema is required")
	}
	rootType, ok := schema["type"].(string)
	if !ok || (rootType != "object" && rootType != "array") {
		return fmt.Errorf("output_schema root type must be object or array")
	}
	return validateSchemaNode(schema, "output_schema")
}

func validateSchemaNode(schema map[string]interface{}, path string) error {
	for keyword := range schema {
		if !supportedKeywords[keyword] {
			return fmt.Errorf("%s contains unsupported keyword %s", path, keyword)
		}
	}
	typeName, ok := schema["type"].(string)
	if !ok || !supportedTypes[typeName] {
		return fmt.Errorf("%s has unsupported or missing type", path)
	}
	if raw, exists := schema["enum"]; exists {
		values, ok := raw.([]interface{})
		if !ok || len(values) == 0 {
			return fmt.Errorf("%s.enum must be a non-empty array", path)
		}
	}
	switch typeName {
	case "object":
		if raw, exists := schema["additionalProperties"]; exists {
			if _, ok := raw.(bool); !ok {
				return fmt.Errorf("%s.additionalProperties must be a boolean", path)
			}
		}
		if raw, exists := schema["properties"]; exists {
			properties, ok := raw.(map[string]interface{})
			if !ok {
				return fmt.Errorf("%s.properties must be an object", path)
			}
			for name, rawProperty := range properties {
				property, ok := rawProperty.(map[string]interface{})
				if !ok {
					return fmt.Errorf("%s.properties.%s must be a schema", path, name)
				}
				if err := validateSchemaNode(property, path+".properties."+name); err != nil {
					return err
				}
			}
		}
		if raw, exists := schema["required"]; exists {
			if _, err := stringList(raw, path+".required"); err != nil {
				return err
			}
		}
	case "array":
		rawItems, exists := schema["items"]
		if !exists {
			return fmt.Errorf("%s.items is required", path)
		}
		items, ok := rawItems.(map[string]interface{})
		if !ok {
			return fmt.Errorf("%s.items must be a schema", path)
		}
		if err := validateSchemaNode(items, path+".items"); err != nil {
			return err
		}
	}
	return nil
}

// Validate checks a decoded provider response against the accepted schema
// subset. Unknown schema keywords do not weaken these checks.
func Validate(value interface{}, schema map[string]interface{}) error {
	if err := ValidateSchema(schema); err != nil {
		return err
	}
	return validateValue(value, schema, "output")
}

func validateValue(value interface{}, schema map[string]interface{}, path string) error {
	typeName := schema["type"].(string)
	if !matchesType(value, typeName) {
		return fmt.Errorf("%s must be %s", path, typeName)
	}
	if enum, ok := schema["enum"].([]interface{}); ok {
		matched := false
		for _, candidate := range enum {
			if reflect.DeepEqual(value, candidate) {
				matched = true
				break
			}
		}
		if !matched {
			return fmt.Errorf("%s is not an allowed value", path)
		}
	}
	switch typeName {
	case "object":
		object := value.(map[string]interface{})
		if rawRequired, exists := schema["required"]; exists {
			required, _ := stringList(rawRequired, path+".required")
			for _, name := range required {
				if _, exists := object[name]; !exists {
					return fmt.Errorf("%s.%s is required", path, name)
				}
			}
		}
		properties, _ := schema["properties"].(map[string]interface{})
		for name, rawProperty := range properties {
			item, exists := object[name]
			if !exists {
				continue
			}
			if err := validateValue(item, rawProperty.(map[string]interface{}), path+"."+name); err != nil {
				return err
			}
		}
		if additional, ok := schema["additionalProperties"].(bool); ok && !additional {
			for name := range object {
				if _, declared := properties[name]; !declared {
					return fmt.Errorf("%s.%s is not declared", path, name)
				}
			}
		}
	case "array":
		items := schema["items"].(map[string]interface{})
		for index, item := range value.([]interface{}) {
			if err := validateValue(item, items, fmt.Sprintf("%s[%d]", path, index)); err != nil {
				return err
			}
		}
	}
	return nil
}

func matchesType(value interface{}, typeName string) bool {
	switch typeName {
	case "null":
		return value == nil
	case "object":
		_, ok := value.(map[string]interface{})
		return ok
	case "array":
		_, ok := value.([]interface{})
		return ok
	case "string":
		_, ok := value.(string)
		return ok
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "number":
		switch value.(type) {
		case json.Number, float64, float32, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
			return true
		default:
			return false
		}
	case "integer":
		switch typed := value.(type) {
		case json.Number:
			_, err := typed.Int64()
			return err == nil
		case float64:
			return !math.IsNaN(typed) && !math.IsInf(typed, 0) && math.Trunc(typed) == typed
		case float32:
			return math.Trunc(float64(typed)) == float64(typed)
		case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
			return true
		default:
			return false
		}
	default:
		return false
	}
}

func stringList(value interface{}, path string) ([]string, error) {
	items, ok := value.([]interface{})
	if !ok {
		if stringsList, ok := value.([]string); ok {
			return stringsList, nil
		}
		return nil, fmt.Errorf("%s must be an array of strings", path)
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok || strings.TrimSpace(text) == "" {
			return nil, fmt.Errorf("%s must contain non-empty strings", path)
		}
		out = append(out, text)
	}
	return out, nil
}
