package redact

import "strings"

// WithoutSecretFields returns a recursively scrubbed copy of values with
// credential-shaped keys removed.
func WithoutSecretFields(values map[string]interface{}) map[string]interface{} {
	safe := make(map[string]interface{}, len(values))
	for key, value := range values {
		if IsSecretField(key) {
			continue
		}
		safe[key] = WithoutNestedSecretFields(value)
	}
	return safe
}

// WithoutNestedSecretFields recursively scrubs maps nested in arbitrary
// response values without mutating the original value.
func WithoutNestedSecretFields(value interface{}) interface{} {
	switch typed := value.(type) {
	case map[string]interface{}:
		return WithoutSecretFields(typed)
	case []interface{}:
		safe := make([]interface{}, len(typed))
		for index, item := range typed {
			safe[index] = WithoutNestedSecretFields(item)
		}
		return safe
	default:
		return value
	}
}

// IsSecretField classifies credential-bearing field names while preserving
// ordinary token-usage metrics such as inputTokens and tokenCount.
func IsSecretField(key string) bool {
	normalized := strings.NewReplacer("_", "", "-", "", ".", "", " ", "").Replace(strings.ToLower(key))
	if strings.Contains(normalized, "apikey") ||
		strings.Contains(normalized, "secret") ||
		strings.Contains(normalized, "password") ||
		strings.Contains(normalized, "passwd") ||
		strings.Contains(normalized, "credential") ||
		strings.Contains(normalized, "privatekey") ||
		strings.Contains(normalized, "connectionstring") {
		return true
	}

	for _, suffix := range []string{
		"accesstoken", "accesstokens", "refreshtoken", "refreshtokens", "authtoken", "authtokens",
		"bearertoken", "bearertokens", "idtoken", "idtokens", "sessiontoken", "sessiontokens",
	} {
		if strings.HasSuffix(normalized, suffix) {
			return true
		}
	}

	switch normalized {
	case "token", "bearer", "authorization":
		return true
	}

	return strings.HasSuffix(normalized, "authorizationheader") ||
		strings.HasSuffix(normalized, "authheader") ||
		strings.HasSuffix(normalized, "dsn") ||
		strings.HasSuffix(normalized, "databaseurl") ||
		strings.HasSuffix(normalized, "redisurl")
}
