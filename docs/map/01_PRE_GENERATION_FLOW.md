# Pre-generation flow

This map covers both model-calling HTTP entries: the session chat path `POST /api/chat/sessions/:id/messages` and the simpler `POST /api/synthesis` path. Both are registered behind authentication, but only the chat path performs retrieval and orchestration before generation. (`backend/internal/api/routes/routes.go:16-16`, `backend/internal/api/routes/routes.go:30-38`, `backend/internal/api/routes/routes.go:96-96`, `backend/internal/api/routes/routes.go:123-128`)

## 1. Entry

### Session chat entry — IMPLEMENTED

`SendChatMessage` receives the session-message request, decodes the body into an untyped map, reads `content` with `message` as a fallback, and rejects a missing value with HTTP 400 `message is required`. (`backend/internal/api/handlers/chat_handler.go:148-155`)

Malformed JSON is not itself rejected because `decodeMap` discards `BodyParser`'s error and returns the empty or partially populated map; the handler then normally reports the missing-message error. (`backend/internal/api/handlers/handler.go:272-275`, `backend/internal/api/handlers/chat_handler.go:149-155`)

The handler also accepts `model`, `mode`, `generate_candidates`, `dry_run`, and four caller-overridable retrieval limits: `top_k_tools`, `top_k_rules`, `top_k_templates`, and `top_k_examples`. (`backend/internal/api/handlers/chat_handler.go:157-158`, `backend/internal/api/handlers/chat_handler.go:187-203`)

`dry_run` is copied into `ChatRequest`, but `HandleChatMessage` never reads `req.DryRun`; for this generation path the field is DEAD. (`backend/internal/api/handlers/chat_handler.go:191-203`, `backend/internal/core/orchestrator/orchestration_models.go:9-21`, `backend/internal/core/orchestrator/chat_orchestrator.go:30-185`)

Before orchestration, the handler looks up the current user, constructs a user message, creates the requested session ID if it does not exist, or hides an inaccessible existing session as HTTP 404, then appends the user message to the repository. (`backend/internal/api/handlers/chat_handler.go:160-174`)

Early exits before a model call are: HTTP 400 for absent message, HTTP 404 for a session owned by another principal, and HTTP 503 if the orchestrator is nil. (`backend/internal/api/handlers/chat_handler.go:149-177`)

### Direct synthesis entry — IMPLEMENTED

`Synthesize` decodes an untyped body map, requires only a non-empty string `prompt`, and also reads optional `mode`, `model`, and caller-supplied `context`; it then calls `Service.Synthesize` directly. (`backend/internal/api/handlers/chat_handler.go:13-25`)

The direct path performs no semantic retrieval, session lookup, intent classification, destructive-identity precheck, executable-tool filtering, or pre-model registry validation; after the model responds it applies only `WorkflowValidator.ValidateYAML`. (`backend/internal/api/handlers/chat_handler.go:13-42`)

Its early exits are HTTP 400 for a missing prompt and a traced HTTP 502 response when provider generation fails. (`backend/internal/api/handlers/chat_handler.go:15-25`)

## 2. Authentication and permissions

Both entries are under a route group that first runs JWT authentication and `RequireUser`; JWT authentication accepts only HS256, requires a valid token with a non-empty `sub`, and stores that subject as the request user ID. (`backend/internal/api/routes/routes.go:30-30`, `backend/internal/api/middlewares/auth.go:13-44`)

Authentication exits with HTTP 401 and `Missing access token`, `Invalid or expired access token`, `Invalid token claims`, or `Invalid token subject`, depending on the failed branch. (`backend/internal/api/middlewares/auth.go:15-41`)

`RequireUser` then checks that the token subject still names an existing active repository user; it returns HTTP 401 if the user disappeared and HTTP 403 if the account is inactive. (`backend/internal/api/handlers/handler.go:119-131`)

The direct synthesis route is gated by the exact permission `workflow:write`; failure is HTTP 403 `Permission denied` with `required: workflow:write`. (`backend/internal/api/routes/routes.go:32-32`, `backend/internal/api/routes/routes.go:96-96`, `backend/internal/api/middlewares/rbac.go:8-16`)

The session-message route is gated by any one of `workflow:write` or `chat:use`; failure is HTTP 403 `Permission denied` with the two values under `requiredAny`. (`backend/internal/api/routes/routes.go:38-38`, `backend/internal/api/routes/routes.go:128-128`, `backend/internal/api/middlewares/rbac.go:19-30`)

An existing session has a second ownership check: a principal with `chat:use` may access it only when `session.OwnerID == user.ID`, while a user with `workflow:read` or `workflow:write` passes the broader workflow permission branch. (`backend/internal/api/handlers/scope_helper.go:57-62`, `backend/internal/api/handlers/chat_handler.go:164-171`)

## 3. Session and context assembly

Chat sessions and their messages are stored in `Store.Chats`; the handler appends the current user message before calling the orchestrator and appends the assistant response only after orchestration succeeds. (`backend/internal/api/handlers/chat_handler.go:164-174`, `backend/internal/api/handlers/chat_handler.go:218-234`)

Prior messages are **not loaded into the generation request**: `ChatRequest` contains only the current `UserText`, and the handler passes `message` rather than `session.Messages` or a conversation summary. (`backend/internal/api/handlers/chat_handler.go:192-204`, `backend/internal/core/orchestrator/orchestration_models.go:9-21`)

The current user's effective role name becomes `UserRole`, unless `CHAT_USER_ROLE_OVERRIDE` replaces it; that role is supplied to retrieval, prompt construction, and later candidate validation. (`backend/internal/api/handlers/chat_handler.go:180-203`, `backend/internal/core/orchestrator/chat_orchestrator.go:47-52`, `backend/internal/core/orchestrator/chat_orchestrator.go:102-121`)

The direct synthesis path uses only the request's supplied `context` object; it does not call the registry-context service or the semantic-search service. (`backend/internal/api/handlers/chat_handler.go:19-27`, `backend/internal/core/synthesizer/ollama_client.go:84-90`)

## 4. Intent extraction

Typed intent extraction is **NOT FOUND**. Searches for `intent`, `classifier`, and typed request/decision models in `backend/internal/core/orchestrator`, `backend/internal/core/synthesizer`, and `backend/internal/api/handlers/chat_handler.go` found no intent type or classifier call; `ChatRequest.UserText` is passed directly as the retrieval query and then as `CandidateGenerationRequest.Prompt`. (`backend/internal/core/orchestrator/orchestration_models.go:9-21`, `backend/internal/core/orchestrator/chat_orchestrator.go:47-52`, `backend/internal/core/orchestrator/chat_orchestrator.go:102-116`)

The decisive code is:

```go
retrieval, err := o.Search.SearchContext(ctx, req.UserText, req.UserRole, semanticsearch.Options{ /* K values */ })
// ... filtering ...
generationRequest := synthesizer.CandidateGenerationRequest{
    Prompt: req.UserText,
    // retrieved objects
}
candidates, err := o.Generator.GenerateCandidates(ctx, generationRequest)
```

This sequence uses raw user text for lexical/embedding retrieval and prompt generation rather than producing a typed intent intermediate. (`backend/internal/core/orchestrator/chat_orchestrator.go:47-52`, `backend/internal/core/orchestrator/chat_orchestrator.go:102-118`)

There are untyped heuristic decisions: `destructiveIdentityRequestErrors` checks text for a forbidden destructive identity request, and `detectRequestDomain` derives a string domain from the query and retrieved objects. (`backend/internal/core/orchestrator/chat_orchestrator.go:57-68`, `backend/internal/core/orchestrator/chat_orchestrator.go:71-79`, `backend/internal/core/orchestrator/chat_orchestrator.go:229-274`, `backend/internal/core/orchestrator/chat_orchestrator.go:506-536`)

## 5. Route and decision logic before generation

There is no general dispatcher choosing clarification, direct execution, template use, or synthesis; the chat route always retrieves and then either blocks, reports unavailable capability, or synthesizes candidates. (`backend/internal/core/orchestrator/chat_orchestrator.go:47-116`)

The first branch occurs after retrieval: destructive administrator or identity requests return `blocked_sensitive_destructive_request` without calling the model. (`backend/internal/core/orchestrator/chat_orchestrator.go:57-69`)

The second branch partitions retrieved tools by registry status, filters them to a detected domain, backfills up to five executable tools, adds control tools, and filters rules against the resulting executable set. (`backend/internal/core/orchestrator/chat_orchestrator.go:71-79`, `backend/internal/core/orchestrator/chat_orchestrator.go:276-318`, `backend/internal/core/orchestrator/chat_orchestrator.go:334-378`, `backend/internal/core/orchestrator/chat_orchestrator.go:538-600`)

If no executable business tool remains, the orchestrator substitutes the registered `capability.create_capability_request` tool when available; otherwise it returns `capability_request_or_schema_generation` without a model call. (`backend/internal/core/orchestrator/chat_orchestrator.go:81-100`, `backend/internal/core/orchestrator/chat_orchestrator.go:320-332`)

Templates do not create a separate route: retrieved templates are bounded context passed into the same candidate-generation prompt. (`backend/internal/core/orchestrator/chat_orchestrator.go:102-116`, `backend/internal/core/synthesizer/candidates.go:118-132`, `backend/internal/core/synthesizer/candidates.go:200-216`)

Clarification is not a pre-generation route; `regenerate_or_request_clarification` is returned only after generation, validation, selection, and one possible repair have all failed to yield a valid candidate. (`backend/internal/core/orchestrator/chat_orchestrator.go:121-141`, `backend/internal/core/orchestrator/chat_orchestrator.go:162-185`)

## 6. Retrieval

The configured default is external embedding retrieval at `SEMANTIC_SEARCH_URL`; lexical fallback is disabled unless `SEMANTIC_FALLBACK=lexical` or the legacy fallback flag is true. (`backend/internal/config/config.go:102-110`, `backend/internal/config/config.go:145-152`)

`SearchContext` sends the raw query, role, and four Top-K values to the external service; an external error either aborts the request or switches to the in-process lexical ranker when fallback is enabled. (`backend/internal/core/semanticsearch/service.go:96-124`, `backend/internal/core/semanticsearch/service.go:160-186`)

The default limits are tools `10`, rules `15`, templates `5`, and examples `5`, and both the handler configuration and search service enforce those defaults for non-positive values. (`backend/internal/config/config.go:147-150`, `backend/internal/api/handlers/chat_handler.go:198-201`, `backend/internal/core/semanticsearch/service.go:96-108`)

Lexical retrieval ranks all four collections and truncates each to its configured Top-K; global rules are returned separately and are not Top-K-truncated by `searchLexical`. (`backend/internal/core/semanticsearch/service.go:127-157`)

The prompt layer applies tighter hard caps: at most ten tools across all statuses, fifteen total rules including at most eight global rules, five templates, and three examples. (`backend/internal/core/synthesizer/candidates.go:15-25`, `backend/internal/core/synthesizer/candidates.go:313-328`)

The generated registry Markdown is deliberately excluded from candidate prompts; only bounded typed retrieval objects are retained. (`backend/internal/core/synthesizer/candidates.go:326-328`, `backend/internal/core/synthesizer/prompt_gen.go:109-112`)

## 7. Prompt construction and model selection

`GenerateCandidates` bounds the request, builds one prompt with `PromptBuilder.BuildCandidatePrompt`, and then calls the active model provider through `generateWithUsage`. (`backend/internal/core/synthesizer/candidates.go:58-75`)

The candidate prompt contains the YAML contract and static examples, executable/missing/future tool summaries, relevant rules, process templates, up to three few-shot examples, repair feedback when present, user role, and redacted current user text. (`backend/internal/core/synthesizer/candidates.go:99-132`, `backend/internal/core/synthesizer/candidates.go:135-216`)

No prompt version or prompt hash is recorded: searches for `prompt version`, `prompt hash`, `version.*prompt`, `sha256`, and `checksum` in `backend/internal/core/synthesizer` and `backend/internal/core/orchestrator` found only a registry-hash string in a prompt test, not runtime prompt provenance. (`backend/internal/core/synthesizer/context_prompt_test.go:10-10`, `backend/internal/core/synthesizer/candidates.go:74-95`)

The service first resolves the active provider from repository configuration; if none is active it falls back to the boot-time Gemini or Ollama selection, and unsupported or unconfigured providers return an error before an HTTP call. (`backend/internal/api/handlers/handler.go:55-63`, `backend/internal/repository/memory.go:190-198`, `backend/internal/core/synthesizer/ollama_client.go:179-208`)

Active provider types route to Gemini, Ollama, or OpenAI-compatible clients; the chosen model can be overridden by the request's `model` value. (`backend/internal/core/synthesizer/ollama_client.go:216-250`)

The actual external calls are Gemini `POST .../models/{model}:generateContent`, Ollama `POST .../api/generate`, or OpenAI-compatible `POST .../chat/completions`. (`backend/internal/core/synthesizer/gemini_client.go:67-68`, `backend/internal/core/synthesizer/ollama_client.go:280-286`, `backend/internal/core/synthesizer/openai_client.go:47-53`)

## 8. Feasibility before generation

General request feasibility is **PARTIAL**: the orchestrator blocks one destructive-identity pattern and checks that at least one executable or capability-request tool remains, but it does not produce a typed plan or prove that retrieved tools collectively satisfy all requested outcomes before calling the model. (`backend/internal/core/orchestrator/chat_orchestrator.go:57-100`, `backend/internal/core/orchestrator/chat_orchestrator.go:102-116`)

A dedicated feasibility or achievability service is **NOT FOUND** after searches for `feasib`, `achiev`, `capability check`, `plan request`, `intent`, and `classifier` under `backend/internal/core`, `backend/internal/api/handlers`, and `backend/internal/models`; the only pre-generation capability decision is executable-tool presence and optional capability-request substitution. (`backend/internal/core/orchestrator/chat_orchestrator.go:71-100`)

## Ordered call sequence to the model

### Session chat

1. `routes.Register` attaches `Auth`, `RequireUser`, `RequireAnyPermission`, and `Handler.SendChatMessage`. (`backend/internal/api/routes/routes.go:12-16`, `backend/internal/api/routes/routes.go:30-38`, `backend/internal/api/routes/routes.go:128-128`)
2. `middlewares.Auth` validates HS256 JWT and records the subject. (`backend/internal/api/middlewares/auth.go:13-44`)
3. `Handler.RequireUser` verifies repository existence and active status. (`backend/internal/api/handlers/handler.go:119-131`)
4. `middlewares.RequireAnyPermission` accepts `workflow:write` or `chat:use`. (`backend/internal/api/routes/routes.go:38-38`, `backend/internal/api/middlewares/rbac.go:19-30`)
5. `Handler.SendChatMessage` calls `decodeMap`, checks message/session ownership, appends the current user message, derives role and limits, then constructs `ChatRequest`. (`backend/internal/api/handlers/chat_handler.go:148-204`, `backend/internal/api/handlers/handler.go:272-275`)
6. `ChatOrchestrator.HandleChatMessage` normalizes limits and calls `semanticsearch.Service.SearchContext`. (`backend/internal/core/orchestrator/chat_orchestrator.go:30-54`)
7. `SearchContext` calls `searchExternal`, or `searchLexical` only when selected or allowed as fallback. (`backend/internal/core/semanticsearch/service.go:96-125`)
8. `HandleChatMessage` calls the destructive-identity check, tool/rule extraction, domain detection, executable backfill, status split, domain/control filtering, and capability fallback. (`backend/internal/core/orchestrator/chat_orchestrator.go:57-100`)
9. `HandleChatMessage` constructs `CandidateGenerationRequest` and calls `Service.GenerateCandidates`. (`backend/internal/core/orchestrator/chat_orchestrator.go:102-118`)
10. `GenerateCandidates` calls `boundCandidateRequest`, `PromptBuilder.BuildCandidatePrompt`, and `Service.generateWithUsage`. (`backend/internal/core/synthesizer/candidates.go:58-75`, `backend/internal/core/synthesizer/candidates.go:313-347`)
11. `generateWithUsage` calls `activeProvider`, then `generateWithConfigUsage`, or the configured boot-time Gemini/Ollama client. (`backend/internal/core/synthesizer/ollama_client.go:179-238`)
12. The selected client's `generateWithUsage` creates and sends the provider HTTP request; this is the model-call boundary. (`backend/internal/core/synthesizer/gemini_client.go:39-68`, `backend/internal/core/synthesizer/ollama_client.go:258-286`, `backend/internal/core/synthesizer/openai_client.go:35-53`)

### Direct synthesis

1. The shared authentication chain runs, followed by exact `workflow:write` permission enforcement. (`backend/internal/api/routes/routes.go:30-32`, `backend/internal/api/routes/routes.go:96-96`)
2. `Handler.Synthesize` calls `decodeMap`, validates `prompt`, and calls `Service.Synthesize`. (`backend/internal/api/handlers/chat_handler.go:13-25`)
3. `Service.Synthesize` calls `PromptBuilder.Build` and `Service.generateWithUsage`. (`backend/internal/core/synthesizer/ollama_client.go:84-90`, `backend/internal/core/synthesizer/prompt_gen.go:84-106`)
4. `generateWithUsage` resolves the provider and invokes its HTTP client as described above. (`backend/internal/core/synthesizer/ollama_client.go:179-238`)
