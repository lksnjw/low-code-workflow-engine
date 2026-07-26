package validator

// SensitiveFieldNames exposes only the field-name fragments used by the
// validator's sensitive-key scan so generation context can describe the
// deterministic gate without reading generated prose.
func SensitiveFieldNames() []string {
	fields := []string{
		"password",
		"token",
		"api_key",
		"apikey",
		"secret",
		"authorization",
		"auth_header",
		"private_key",
	}
	out := make([]string, len(fields))
	copy(out, fields)
	return out
}
