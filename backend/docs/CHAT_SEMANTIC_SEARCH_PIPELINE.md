# Chat Semantic Search Pipeline

## 1. Purpose

The chat endpoint is now the main research pipeline for turning a natural-language low-code workflow request into a validated YAML workflow candidate.

Implemented flow:

```text
POST /api/chat/sessions/:id/messages
-> save user chat message
-> semantic search over backend tool and rule registries
-> build controlled LLM prompt with retrieved context
-> generate multiple YAML candidates
-> parse and validate each candidate against the full registry
-> rank valid candidates
-> save assistant response and selected artifact
-> return validation evidence to the frontend
```

The backend remains the controller. Semantic search helps choose prompt context, and the LLM generates draft YAML only. The Go validator decides whether a workflow can execute.

## 2. Semantic Search

Semantic search is implemented locally in Go in `internal/core/semanticsearch`.

Current retrieval mode:

```text
SEMANTIC_SEARCH_MODE=go_lexical
```

The service builds searchable text from:

- tool name, display name, module, description, capability, parameters, and semantic keywords
- rule name, type, domain, description, applies-to tools, validator message, and prompt instruction

The first implementation uses lexical and semantic-like matching:

- token overlap
- split matching for dotted action names such as `procurement.create_purchase_order`
- light singular/plural normalization
- exact tool phrase boost
- role relevance boost
- rule-to-retrieved-tool boost
- always included global safety rules

No Gemini or external LLM is used for semantic search.

## 3. Tool and Rule Loading

Registries are loaded during backend startup from JSON:

```env
TOOL_REGISTRY_PATH=./configs/registries/all_tools_master_registry.json
RULE_REGISTRY_PATH=./configs/registries/all_rules_master_registry.json
```

Implemented registry package:

```text
internal/core/registry
```

Main functions:

- `GetAllTools()`
- `GetAllRules()`
- `FindToolByName(name)`
- `FindRulesByTool(toolName)`
- `GetGlobalSafetyRules()`
- `GetEnabledRules()`

If a registry file is missing, the backend starts with an empty registry and logs a warning. Invalid JSON returns a startup error.

## 4. LLM Usage

The existing synthesizer remains the workflow generator.

Implemented path:

```text
internal/core/synthesizer.GenerateCandidates
```

The prompt builder injects:

- authenticated user role
- original chat request
- retrieved tools
- retrieved rules
- output YAML schema
- safety instructions

The prompt explicitly tells the model to:

- use only available tools
- include required parameters
- follow governance rules
- avoid secrets
- return multiple candidates

If Ollama is disabled or fails, the service returns deterministic fallback candidates and marks them with `generation_metadata.fallback=true`. Fallback output is not treated as real model output.

## 5. Validation Authority

The Go registry validator is the final authority:

```text
internal/core/validator/registry_validator.go
```

Validation uses the full loaded registry, not only the retrieved context.

Implemented checks:

- YAML parse validity
- schema checks for name, trigger, and steps
- description required for generated candidates
- tool existence and hallucinated action blocking
- tool status checks
- required parameter checks
- RBAC checks
- amount and quantity threshold checks
- process-order checks
- separation-of-duties checks
- high-risk approval checks
- write/high-risk audit checks
- sensitive parameter blocking for keys like `token`, `api_key`, `password`, and `secret`

Validation scoring:

| Check | Weight |
|---|---:|
| Schema validity | 0.20 |
| Tool validity | 0.20 |
| Parameter completeness | 0.20 |
| RBAC compliance | 0.15 |
| Policy compliance | 0.15 |
| Process-order compliance | 0.05 |
| Risk-control compliance | 0.05 |

A high score cannot override a mandatory failure. `passed=true` is required before execution.

## 6. Chat API Behavior

Endpoint:

```http
POST /api/chat/sessions/:id/messages
```

Request:

```json
{
  "content": "Create a purchase order for 150 laptops from vendor V-882 and send it for approval.",
  "mode": "generate_workflow",
  "top_k_tools": 10,
  "top_k_rules": 15,
  "generate_candidates": 5
}
```

The handler also accepts the previous `message` field for compatibility.

Response includes:

- assistant message
- retrieved tools and rules with scores
- candidate YAML strings
- candidate validation results
- selected candidate ID
- selected workflow YAML
- `can_execute`
- validation summary
- blocking errors when no candidate passes

Successful candidate response shape:

```json
{
  "success": true,
  "data": {
    "session_id": "chat_001",
    "assistant_message": "I generated and validated workflow candidates. The best valid workflow is ready for review.",
    "selected_candidate_id": "candidate_1",
    "can_execute": true,
    "validation_summary": {
      "passed_candidates": 2,
      "blocked_candidates": 3,
      "best_score": 0.96
    }
  }
}
```

If all candidates fail:

```json
{
  "success": true,
  "data": {
    "can_execute": false,
    "selected_candidate_id": "",
    "selected_workflow_yaml": "",
    "blocking_errors": [
      "No candidate passed full semantic validation."
    ],
    "next_action": "regenerate_or_request_clarification"
  }
}
```

## 7. Execution Safety

Workflow execution now performs full registry validation before running through the sequential runner.

Important safety behavior:

- unknown generated actions are blocked before execution
- unvalidated workflows are rejected by the execution handler
- dry-run requests return planned steps without invoking tools
- repaired YAML from the self-healing scaffold is validated before it is saved

The development MCP fallback remains available for registered registry actions, but hallucinated actions are blocked by the registry validator before the runner is reached.

## 8. Current Limitations and Next Steps

Current limitations:

- semantic search is local lexical scoring, not embeddings or FAISS
- Gemini is not implemented
- self-healing regeneration is scaffolded but not a full validation-feedback loop yet
- no persistent database-backed registry storage
- no request ID propagation yet
- no external vector microservice client yet

Recommended next steps:

- add optional external semantic search service through `SEMANTIC_SEARCH_URL`
- add Gemini behind the existing generator interface if needed
- implement regeneration/self-healing endpoint that feeds validator errors back into generation
- persist registries and generated artifacts in PostgreSQL
- add request IDs and structured audit records for every chat generation
