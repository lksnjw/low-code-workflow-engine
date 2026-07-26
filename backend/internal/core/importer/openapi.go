package importer

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"gopkg.in/yaml.v3"
)

var openAPIMethods = map[string]bool{
	"get": true, "head": true, "post": true, "put": true, "patch": true, "delete": true,
}

func normaliseOpenAPI(filename string, content []byte, prefix string) ([]ImportRecord, error) {
	document, err := parseOpenAPIDocument(filename, content)
	if err != nil {
		return nil, err
	}
	version, _ := document["openapi"].(string)
	if !strings.HasPrefix(version, "3.0") && !strings.HasPrefix(version, "3.1") {
		return nil, fmt.Errorf("openapi must declare version 3.0 or 3.1, got %q", version)
	}
	cleanPrefix, err := sanitisePrefix(prefix)
	if err != nil {
		return nil, err
	}
	paths, ok := document["paths"].(map[string]interface{})
	if !ok || len(paths) == 0 {
		return nil, errors.New("openapi paths must be a non-empty object")
	}
	pathNames := make([]string, 0, len(paths))
	for path := range paths {
		pathNames = append(pathNames, path)
	}
	sort.Strings(pathNames)
	records := []ImportRecord{}
	index := 0
	for _, path := range pathNames {
		pathItemRaw := paths[path]
		pathItem, err := resolveObject(document, pathItemRaw, map[string]bool{})
		if err != nil {
			return nil, fmt.Errorf("path %s: %w", path, err)
		}
		pathParameters, err := parameterList(document, pathItem["parameters"])
		if err != nil {
			return nil, fmt.Errorf("path %s parameters: %w", path, err)
		}
		methodNames := make([]string, 0, len(pathItem))
		for method := range pathItem {
			if openAPIMethods[strings.ToLower(method)] {
				methodNames = append(methodNames, strings.ToLower(method))
			}
		}
		sort.Strings(methodNames)
		for _, method := range methodNames {
			line := lineForText(content, path)
			record, recordErr := openAPIOperationRecord(document, filename, cleanPrefix, path, method, pathParameters, pathItem[method], line, index)
			if recordErr != nil {
				record = ImportRecord{
					RecordID: fmt.Sprintf("openapi:%d", index), RegistryKind: SourceTools, SourceID: path + " " + strings.ToUpper(method),
					Line: line, Index: index, Category: "Rejected", Changes: []FieldChange{}, Errors: []RecordError{{
						RecordID: path + " " + strings.ToUpper(method), Line: line, Index: index, Field: "operation", Reason: recordErr.Error(),
					}}, RequiresConfirmation: true,
				}
			}
			records = append(records, record)
			index++
		}
	}
	if len(records) == 0 {
		return nil, errors.New("openapi document contains no supported HTTP operations")
	}
	return records, nil
}

func parseOpenAPIDocument(filename string, content []byte) (map[string]interface{}, error) {
	format, err := detectFormat(filename, content)
	if err != nil {
		return nil, err
	}
	if format == "csv" {
		return nil, errors.New("openapi documents must be JSON or YAML")
	}
	var value interface{}
	if format == "json" {
		decoder := json.NewDecoder(bytes.NewReader(content))
		decoder.UseNumber()
		if err := decoder.Decode(&value); err != nil {
			return nil, fmt.Errorf("invalid openapi JSON: %w", err)
		}
	} else if err := yaml.Unmarshal(content, &value); err != nil {
		return nil, fmt.Errorf("invalid openapi YAML: %w", err)
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("normalise openapi document: %w", err)
	}
	var document map[string]interface{}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&document); err != nil {
		return nil, fmt.Errorf("openapi root must be an object: %w", err)
	}
	return document, nil
}

func openAPIOperationRecord(root map[string]interface{}, filename, prefix, path, method string, inheritedParameters []interface{}, raw interface{}, line, index int) (ImportRecord, error) {
	operation, err := resolveObject(root, raw, map[string]bool{})
	if err != nil {
		return ImportRecord{}, err
	}
	operationID, _ := operation["operationId"].(string)
	action := sanitiseSegment(operationID)
	if action == "" {
		return ImportRecord{}, errors.New("operationId is required and must contain letters or numbers")
	}
	name := prefix + "." + action
	parameters, err := parameterList(root, operation["parameters"])
	if err != nil {
		return ImportRecord{}, fmt.Errorf("parameters: %w", err)
	}
	parameters = append(append([]interface{}{}, inheritedParameters...), parameters...)
	properties := map[string]interface{}{}
	requiredSet := map[string]bool{}
	for _, parameterRaw := range parameters {
		parameter, err := resolveObject(root, parameterRaw, map[string]bool{})
		if err != nil {
			return ImportRecord{}, fmt.Errorf("parameter: %w", err)
		}
		location, _ := parameter["in"].(string)
		if location != "path" && location != "query" && location != "header" {
			continue
		}
		parameterName, _ := parameter["name"].(string)
		if strings.TrimSpace(parameterName) == "" {
			return ImportRecord{}, errors.New("path, query, and header parameters must have a name")
		}
		schemaRaw, exists := parameter["schema"]
		if !exists {
			return ImportRecord{}, fmt.Errorf("parameter %s is missing schema", parameterName)
		}
		schema, err := resolveSchema(root, schemaRaw, map[string]bool{})
		if err != nil {
			return ImportRecord{}, fmt.Errorf("parameter %s schema: %w", parameterName, err)
		}
		if _, ok := schema["type"].(string); !ok {
			return ImportRecord{}, fmt.Errorf("parameter %s schema must declare a concrete type", parameterName)
		}
		properties[parameterName] = schema
		required, _ := parameter["required"].(bool)
		if location == "path" || required {
			requiredSet[parameterName] = true
		}
	}
	if requestBodyRaw, exists := operation["requestBody"]; exists {
		requestBody, err := resolveObject(root, requestBodyRaw, map[string]bool{})
		if err != nil {
			return ImportRecord{}, fmt.Errorf("requestBody: %w", err)
		}
		content, _ := requestBody["content"].(map[string]interface{})
		media := preferredMedia(content)
		if media != nil {
			schema, err := resolveSchema(root, media["schema"], map[string]bool{})
			if err != nil {
				return ImportRecord{}, fmt.Errorf("requestBody schema: %w", err)
			}
			bodyProperties, objectOK := schema["properties"].(map[string]interface{})
			if schema["type"] == "object" && objectOK {
				for propertyName, propertySchemaRaw := range bodyProperties {
					propertySchema, err := resolveSchema(root, propertySchemaRaw, map[string]bool{})
					if err != nil {
						return ImportRecord{}, fmt.Errorf("requestBody property %s: %w", propertyName, err)
					}
					properties[propertyName] = propertySchema
				}
				for _, requiredName := range interfaceStrings(schema["required"]) {
					requiredSet[requiredName] = true
				}
			} else {
				if _, ok := schema["type"].(string); !ok {
					return ImportRecord{}, errors.New("requestBody schema must declare a concrete type")
				}
				properties["body"] = schema
				required, _ := requestBody["required"].(bool)
				if required {
					requiredSet["body"] = true
				}
			}
		}
	}
	required := make([]string, 0, len(requiredSet))
	optional := []string{}
	for name := range properties {
		if requiredSet[name] {
			required = append(required, name)
		} else {
			optional = append(optional, name)
		}
	}
	sort.Strings(required)
	sort.Strings(optional)
	summary := firstString(operation["summary"], operation["description"], operationID)
	description := firstString(operation["description"], operation["summary"], "Imported from "+filename)
	risk := riskForMethod(method)
	isReadOnly := method == "get" || method == "head"
	sideEffects := []string{}
	if !isReadOnly {
		sideEffects = []string{"May change external state through " + strings.ToUpper(method) + " " + path + "."}
	}
	sum := sha256.Sum256([]byte(name))
	toolID := "OPENAPI-" + strings.ToUpper(hex.EncodeToString(sum[:])[:12])
	inputSchema := map[string]interface{}{"type": "object", "properties": properties, "required": required}
	tool := registry.Tool{
		ToolID: toolID, Name: name, DisplayName: summary, Module: strings.Split(prefix, ".")[0],
		Status: "active_mcp_schema_present", Description: description, BusinessCapability: summary,
		BPIProcessAlignment: []string{}, Endpoint: path, HTTPMethod: strings.ToUpper(method), MCPToolName: name,
		InputSchema: inputSchema, RequiredParameters: required, OptionalParameters: optional,
		AllowedRoles: []string{"Platform Admin", "System Admin", "Workflow Builder", "Client"},
		RiskLevel:    risk, IsReadOnly: isReadOnly, SideEffects: sideEffects, Preconditions: []string{},
		Postconditions: []string{}, FailureModes: []string{"API request failed"},
		ValidatorChecks:           []string{"tool_exists", "parameters_present", "rbac"},
		PromptUsageGuidance:       "Use this operation only with the parameters declared by the imported OpenAPI contract.",
		SemanticSearchKeywords:    []string{strings.Split(prefix, ".")[0], action},
		SemanticSearchDescription: description,
		ExecutionNotes:            "Imported from " + filename + "; confirm the inferred risk level before commit.",
		CurrentGaps:               []string{},
	}
	toolRaw, err := json.Marshal(tool)
	if err != nil {
		return ImportRecord{}, fmt.Errorf("encode normalised tool: %w", err)
	}
	tool, err = registry.DecodeToolStrict(toolRaw)
	if err != nil {
		return ImportRecord{}, fmt.Errorf("normalised tool failed strict registry validation: %w", err)
	}
	responseSchema, err := firstSuccessResponseSchema(root, operation)
	if err != nil {
		return ImportRecord{}, err
	}
	metadata := map[string]interface{}{
		"source_operation": map[string]interface{}{"method": strings.ToUpper(method), "path": path, "operationId": operationID},
		"inferred_risk":    risk,
	}
	if responseSchema != nil {
		metadata["response_schema"] = responseSchema
		metadata["response_schema_enforced"] = false
	}
	return ImportRecord{
		RecordID: "tool:" + tool.ToolID, RegistryKind: SourceTools, SourceID: tool.ToolID,
		Line: line, Index: index, Tool: &tool, Changes: []FieldChange{}, Errors: []RecordError{},
		Metadata: metadata, RequiresConfirmation: true,
	}, nil
}

func parameterList(root map[string]interface{}, value interface{}) ([]interface{}, error) {
	if value == nil {
		return []interface{}{}, nil
	}
	list, ok := value.([]interface{})
	if !ok {
		return nil, errors.New("must be an array")
	}
	for _, raw := range list {
		if reference, ok := raw.(map[string]interface{}); ok {
			if ref, exists := reference["$ref"].(string); exists && !strings.HasPrefix(ref, "#/") {
				return nil, fmt.Errorf("external reference %q is not allowed", ref)
			}
		}
	}
	return list, nil
}

func resolveObject(root map[string]interface{}, value interface{}, seen map[string]bool) (map[string]interface{}, error) {
	resolved, err := resolveReference(root, value, seen)
	if err != nil {
		return nil, err
	}
	object, ok := resolved.(map[string]interface{})
	if !ok {
		return nil, errors.New("must resolve to an object")
	}
	return object, nil
}

func resolveSchema(root map[string]interface{}, value interface{}, seen map[string]bool) (map[string]interface{}, error) {
	object, err := resolveObject(root, value, seen)
	if err != nil {
		return nil, err
	}
	out := make(map[string]interface{}, len(object))
	for key, item := range object {
		switch key {
		case "properties":
			properties, ok := item.(map[string]interface{})
			if !ok {
				return nil, errors.New("properties must be an object")
			}
			resolvedProperties := make(map[string]interface{}, len(properties))
			for name, property := range properties {
				resolved, err := resolveSchema(root, property, copySeen(seen))
				if err != nil {
					return nil, fmt.Errorf("property %s: %w", name, err)
				}
				resolvedProperties[name] = resolved
			}
			out[key] = resolvedProperties
		case "items":
			resolved, err := resolveSchema(root, item, copySeen(seen))
			if err != nil {
				return nil, fmt.Errorf("items: %w", err)
			}
			out[key] = resolved
		default:
			out[key] = item
		}
	}
	return out, nil
}

func resolveReference(root map[string]interface{}, value interface{}, seen map[string]bool) (interface{}, error) {
	object, ok := value.(map[string]interface{})
	if !ok {
		return value, nil
	}
	ref, hasRef := object["$ref"].(string)
	if !hasRef {
		return object, nil
	}
	if !strings.HasPrefix(ref, "#/") {
		return nil, fmt.Errorf("external reference %q is not allowed", ref)
	}
	if seen[ref] {
		return nil, fmt.Errorf("cyclic reference %q is not supported", ref)
	}
	seen[ref] = true
	var current interface{} = root
	for _, token := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
		token = strings.ReplaceAll(strings.ReplaceAll(token, "~1", "/"), "~0", "~")
		object, ok := current.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("reference %q does not resolve to an object", ref)
		}
		var exists bool
		current, exists = object[token]
		if !exists {
			return nil, fmt.Errorf("reference %q was not found", ref)
		}
	}
	resolved, err := resolveReference(root, current, seen)
	if err != nil {
		return nil, err
	}
	if resolvedObject, ok := resolved.(map[string]interface{}); ok {
		merged := make(map[string]interface{}, len(resolvedObject)+len(object))
		for key, item := range resolvedObject {
			merged[key] = item
		}
		for key, item := range object {
			if key != "$ref" {
				merged[key] = item
			}
		}
		return merged, nil
	}
	return resolved, nil
}

func firstSuccessResponseSchema(root map[string]interface{}, operation map[string]interface{}) (interface{}, error) {
	responses, _ := operation["responses"].(map[string]interface{})
	codes := make([]string, 0, len(responses))
	for code := range responses {
		if strings.HasPrefix(code, "2") {
			codes = append(codes, code)
		}
	}
	sort.Strings(codes)
	for _, code := range codes {
		response, err := resolveObject(root, responses[code], map[string]bool{})
		if err != nil {
			return nil, fmt.Errorf("response %s: %w", code, err)
		}
		content, _ := response["content"].(map[string]interface{})
		media := preferredMedia(content)
		if media == nil || media["schema"] == nil {
			continue
		}
		schema, err := resolveSchema(root, media["schema"], map[string]bool{})
		if err != nil {
			return nil, fmt.Errorf("response %s schema: %w", code, err)
		}
		return map[string]interface{}{"status": code, "schema": schema}, nil
	}
	return nil, nil
}

func preferredMedia(content map[string]interface{}) map[string]interface{} {
	if content == nil {
		return nil
	}
	if media, ok := content["application/json"].(map[string]interface{}); ok {
		return media
	}
	names := make([]string, 0, len(content))
	for name := range content {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if media, ok := content[name].(map[string]interface{}); ok {
			return media
		}
	}
	return nil
}

func sanitisePrefix(prefix string) (string, error) {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(prefix)), ".")
	if len(parts) < 2 {
		return "", errors.New("openapi namespace prefix must contain at least two segments, such as domain.entity")
	}
	for index, part := range parts {
		parts[index] = sanitiseSegment(part)
		if parts[index] == "" {
			return "", errors.New("openapi namespace prefix contains an empty segment")
		}
	}
	return strings.Join(parts, "."), nil
}

func sanitiseSegment(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	builder := strings.Builder{}
	lastUnderscore := false
	for _, char := range value {
		alphaNumeric := char >= 'a' && char <= 'z' || char >= '0' && char <= '9'
		if alphaNumeric {
			builder.WriteRune(char)
			lastUnderscore = false
		} else if builder.Len() > 0 && !lastUnderscore {
			builder.WriteByte('_')
			lastUnderscore = true
		}
	}
	return strings.Trim(builder.String(), "_")
}

func riskForMethod(method string) string {
	switch strings.ToUpper(method) {
	case http.MethodGet, http.MethodHead:
		return "low"
	case http.MethodDelete:
		return "high"
	default:
		return "medium"
	}
}

func firstString(values ...interface{}) string {
	for _, value := range values {
		if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
			return strings.TrimSpace(text)
		}
	}
	return "Imported API operation"
}

func copySeen(seen map[string]bool) map[string]bool {
	out := make(map[string]bool, len(seen))
	for key, value := range seen {
		out[key] = value
	}
	return out
}

func lineForText(content []byte, text string) int {
	offset := bytes.Index(content, []byte(text))
	if offset < 0 {
		return 1
	}
	return bytes.Count(content[:offset], []byte("\n")) + 1
}
