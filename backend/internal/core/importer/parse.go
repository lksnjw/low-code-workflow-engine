package importer

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

type sourceRecord struct {
	Raw    json.RawMessage
	Line   int
	Index  int
	Errors []RecordError
}

func parseRegistryRecords(filename string, content []byte) ([]sourceRecord, error) {
	format, err := detectFormat(filename, content)
	if err != nil {
		return nil, err
	}
	switch format {
	case "json":
		return parseJSONRecords(content)
	case "yaml":
		return parseYAMLRecords(content)
	case "csv":
		return parseCSVRecords(content)
	default:
		return nil, fmt.Errorf("unsupported import format %q", format)
	}
}

func detectFormat(filename string, content []byte) (string, error) {
	extension := strings.ToLower(filepath.Ext(strings.TrimSpace(filename)))
	trimmed := bytes.TrimSpace(content)
	if len(trimmed) == 0 {
		return "", errors.New("the uploaded file is empty")
	}
	switch extension {
	case ".json":
		if trimmed[0] != '[' && trimmed[0] != '{' {
			return "", errors.New("the .json extension does not match the uploaded content")
		}
		return "json", nil
	case ".yaml", ".yml":
		return "yaml", nil
	case ".csv":
		return "csv", nil
	case "":
		if trimmed[0] == '[' || trimmed[0] == '{' {
			return "json", nil
		}
		if bytes.Contains(trimmed, []byte(",")) && bytes.Contains(trimmed, []byte("\n")) {
			return "csv", nil
		}
		return "yaml", nil
	default:
		return "", fmt.Errorf("unsupported file extension %q; use .json, .yaml, .yml, or .csv", extension)
	}
}

func parseJSONRecords(content []byte) ([]sourceRecord, error) {
	var items []json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	if err := decoder.Decode(&items); err != nil {
		return nil, fmt.Errorf("expected a JSON array of registry records: %w", err)
	}
	var extra interface{}
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, errors.New("the file must contain exactly one JSON document")
	}
	records := make([]sourceRecord, 0, len(items))
	cursor := 0
	for index, item := range items {
		offset := bytes.Index(content[cursor:], bytes.TrimSpace(item))
		line := 1
		if offset >= 0 {
			cursor += offset
			line += bytes.Count(content[:cursor], []byte("\n"))
			cursor += len(bytes.TrimSpace(item))
		}
		records = append(records, sourceRecord{Raw: item, Line: line, Index: index, Errors: []RecordError{}})
	}
	return records, nil
}

func parseYAMLRecords(content []byte) ([]sourceRecord, error) {
	var document yaml.Node
	if err := yaml.Unmarshal(content, &document); err != nil {
		return nil, fmt.Errorf("invalid YAML: %w", err)
	}
	if len(document.Content) == 0 || document.Content[0].Kind != yaml.SequenceNode {
		return nil, errors.New("expected a YAML sequence of registry records")
	}
	sequence := document.Content[0]
	records := make([]sourceRecord, 0, len(sequence.Content))
	for index, node := range sequence.Content {
		var value interface{}
		if err := node.Decode(&value); err != nil {
			records = append(records, sourceRecord{
				Raw: []byte("{}"), Line: node.Line, Index: index,
				Errors: []RecordError{{Line: node.Line, Index: index, Field: "record", Reason: fmt.Sprintf("YAML record could not be decoded: %v", err)}},
			})
			continue
		}
		raw, err := json.Marshal(value)
		if err != nil {
			records = append(records, sourceRecord{
				Raw: []byte("{}"), Line: node.Line, Index: index,
				Errors: []RecordError{{Line: node.Line, Index: index, Field: "record", Reason: fmt.Sprintf("YAML record could not be normalised: %v", err)}},
			})
			continue
		}
		records = append(records, sourceRecord{Raw: raw, Line: node.Line, Index: index, Errors: []RecordError{}})
	}
	return records, nil
}

func parseCSVRecords(content []byte) ([]sourceRecord, error) {
	reader := csv.NewReader(bytes.NewReader(content))
	reader.TrimLeadingSpace = true
	rows, err := reader.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("invalid CSV: %w", err)
	}
	if len(rows) < 2 {
		return nil, errors.New("CSV must contain a header and at least one record")
	}
	headers := rows[0]
	records := make([]sourceRecord, 0, len(rows)-1)
	for rowIndex, row := range rows[1:] {
		line := rowIndex + 2
		if len(row) != len(headers) {
			records = append(records, sourceRecord{
				Raw: []byte("{}"), Line: line, Index: rowIndex,
				Errors: []RecordError{{Line: line, Index: rowIndex, Field: "record", Reason: fmt.Sprintf("has %d columns; expected %d", len(row), len(headers))}},
			})
			continue
		}
		value := make(map[string]interface{}, len(headers))
		recordErrors := []RecordError{}
		for column, header := range headers {
			header = strings.TrimSpace(header)
			cell := strings.TrimSpace(row[column])
			if header == "" {
				return nil, fmt.Errorf("CSV column %d has an empty header", column+1)
			}
			parsed, err := parseCSVCell(header, cell)
			if err != nil {
				recordErrors = append(recordErrors, RecordError{Line: line, Index: rowIndex, Field: header, Reason: err.Error()})
				continue
			}
			value[header] = parsed
		}
		raw, err := json.Marshal(value)
		if err != nil {
			recordErrors = append(recordErrors, RecordError{Line: line, Index: rowIndex, Field: "record", Reason: fmt.Sprintf("could not be normalised: %v", err)})
			raw = []byte("{}")
		}
		records = append(records, sourceRecord{Raw: raw, Line: line, Index: rowIndex, Errors: recordErrors})
	}
	return records, nil
}

func parseCSVCell(header, cell string) (interface{}, error) {
	switch header {
	case "is_read_only", "enabled":
		value, err := strconv.ParseBool(cell)
		if err != nil {
			return nil, errors.New("must be true or false")
		}
		return value, nil
	case "input_schema", "condition", "bpi_process_alignment", "required_parameters",
		"optional_parameters", "allowed_roles", "side_effects", "preconditions",
		"postconditions", "failure_modes", "validator_checks", "semantic_search_keywords",
		"current_gaps", "applies_to_tools", "applies_to_roles", "bpi_alignment",
		"audit_fields_required":
		if cell == "" {
			if header == "input_schema" || header == "condition" {
				return nil, errors.New("must contain a JSON object")
			}
			return []interface{}{}, nil
		}
		var value interface{}
		decoder := json.NewDecoder(strings.NewReader(cell))
		decoder.UseNumber()
		if err := decoder.Decode(&value); err != nil {
			return nil, fmt.Errorf("must contain valid JSON: %w", err)
		}
		return value, nil
	default:
		return cell, nil
	}
}
