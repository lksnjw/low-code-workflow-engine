# Prompt provenance

Workflow candidate generation records two non-sensitive provenance fields on every candidate:

- `promptTemplateVersion`: `prompt/candidate/v1`
- `promptSha256`: `sha256:<lowercase hexadecimal digest>` of the fully assembled prompt sent to the configured model provider

Increment the final version segment whenever the candidate prompt contract, static instructions, return format, or assembly semantics change in a way that can affect model output. Retrieval results and user input can change the digest without changing the template version.

The raw assembled prompt is not retained in generation metadata. The digest provides invocation identity without storing the prompt's potentially sensitive request or registry context.
