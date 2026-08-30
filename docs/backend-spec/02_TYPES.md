# 2. Boundary and domain types

## Serialization rules used below

“Optional” means the JSON key can be omitted by Go's encoder because its tag contains `omitempty`. A pointer without `omitempty` is not optional on output: the key is emitted as `null` when nil. A slice/map without `omitempty` is likewise emitted as `null` when nil. `json:"-"` means the field never crosses the JSON boundary. `time.Time` and `*time.Time` use Go's standard RFC 3339 JSON string representation. [backend/internal/models/workflow.go:58-150](../../backend/internal/models/workflow.go) [backend/internal/models/state.go:38-95](../../backend/internal/models/state.go)

Request-body structs are decoded by Fiber without automatic `validate`-tag execution. The handler's `parseBody` only calls `BodyParser`; login and registration then perform their own checks. Consequently, the `validate` tags on `LoginRequest`, `RegisterRequest`, and `CreateWorkflowRequest` are descriptive/inert in the HTTP path, except where equivalent manual checks exist. [backend/internal/api/handlers/handler.go:99-104](../../backend/internal/api/handlers/handler.go) [backend/internal/api/handlers/auth_handler.go:17-25](../../backend/internal/api/handlers/auth_handler.go) [backend/internal/api/handlers/auth_handler.go:72-81](../../backend/internal/api/handlers/auth_handler.go) [backend/internal/api/handlers/workflow_handler.go:68-80](../../backend/internal/api/handlers/workflow_handler.go)

## Workflow blueprint (YAML/JSON boundary)

| Field | Go type | JSON / YAML key | Optional | Meaning of zero value |
|---|---|---|---|---|
| `Name` | `string` | `name` / `name` | No | Invalid: `required` |
| `Description` | `string` | `description` / `description` | Yes | Omitted; full registry gate separately rejects blank descriptions |
| `Trigger` | `BlueprintTrigger` | `trigger` / `trigger` | No | Struct is present but invalid when its `Type` is empty |
| `Steps` | `[]WorkflowStepBlueprint` | `steps` / `steps` | No | Nil/empty invalid: `required,min=1`; `dive` validates each element |
| `Metadata` | `map[string]interface{}` | `metadata` / `metadata` | Yes | Omitted |

`BlueprintTrigger` has `Type string` (`type`, required), `DisplayName string` (`displayName`, optional), and `Config map[string]interface{}` (`config`, optional). [backend/internal/models/workflow.go:19-31](../../backend/internal/models/workflow.go)

`WorkflowStepBlueprint` fields are exact as follows. [backend/internal/models/workflow.go:33-48](../../backend/internal/models/workflow.go)

| Field | Go type | JSON / YAML key | Optional | Zero-value behavior |
|---|---|---|---|---|
| `ID` | `string` | `id` / `id` | No | Invalid: `required` |
| `Kind` | `string` | `kind` / `kind` | Yes | `EffectiveKind()` returns `"tool"` |
| `Type` | `string` | `type` / `type` | Yes | No intrinsic meaning in this type |
| `Action` | `string` | `action` / `action` | Yes in encoding | Invalid unless the literal `Kind` field equals `analysis`; note the tag tests `Kind`, not `EffectiveKind()` |
| `Parameters` | `map[string]interface{}` | `parameters` / `parameters` | Yes | Omitted; treated as no parameters |
| `Instruction` | `string` | `instruction` / `instruction` | Yes | Blank |
| `Input` | `string` | `input` / `input` | Yes | Blank |
| `OutputSchema` | `map[string]interface{}` | `output_schema` / `output_schema` | Yes | Omitted |
| `MaxInputItems` | `int` | `max_input_items` / `max_input_items` | Yes | Analysis runner substitutes `200` |
| `MaxInputChars` | `int` | `max_input_chars` / `max_input_chars` | Yes | Analysis runner substitutes `20000` |
| `Condition` | `string` | `condition` / `condition` | Yes | Blank |
| `OnError` | `string` | `onError` / `onError` | Yes | Blank |
| `RetryCount` | `int` | `retryCount` / `retryCount` | Yes | No retries and makes `hasRetryBudget` false unless another step is positive |
| `Description` | `string` | `description` / `description` | Yes | Blank |

The two step kinds defined in code are `"tool"` and `"analysis"`; blank kind normalizes to `"tool"`. [backend/internal/models/workflow.go:15-16](../../backend/internal/models/workflow.go) [backend/internal/models/workflow.go:50-56](../../backend/internal/models/workflow.go)

Literal JSON shape:

```json
{
  "name": "Monthly attendance review",
  "description": "Fetch attendance and summarize exceptions",
  "trigger": {"type": "manual", "displayName": "Run now", "config": {}},
  "steps": [
    {
      "id": "fetch",
      "kind": "tool",
      "action": "fetch_attendance",
      "parameters": {"employee_id": "{{input.employee_id}}"},
      "onError": "fail",
      "retryCount": 1
    },
    {
      "id": "summarize",
      "kind": "analysis",
      "instruction": "Summarize attendance exceptions",
      "input": "{{fetch.result}}",
      "output_schema": {"type": "object", "required": ["summary"], "properties": {"summary": {"type": "string"}}},
      "max_input_items": 200,
      "max_input_chars": 20000
    }
  ],
  "metadata": {"owner": "operations"}
}
```

The Playground validator enforces `required`, `min=1`, `dive`, and `required_unless=Kind analysis` on this graph in both workflow schema validation and the full registry gate. The full gate adds a non-tag rule requiring a nonblank description. [backend/internal/core/validator/schema_check.go:19-41](../../backend/internal/core/validator/schema_check.go) [backend/internal/core/validator/registry_validator.go:147-164](../../backend/internal/core/validator/registry_validator.go)

## Stored/presented workflow and version

`Workflow` has the following fields. [backend/internal/models/workflow.go:58-79](../../backend/internal/models/workflow.go)

| Field | Go type | JSON key | Optional / hidden |
|---|---|---|---|
| `ID` | `string` | `id` | Required key |
| `Name` | `string` | `name` | Required key |
| `Description` | `string` | `description` | Required key |
| `Owner` | `Principal` | `owner` | Required key |
| `AssignedUserIDs` | `[]string` | `assignedUserIds` | Required key; nil becomes `null` |
| `Status` | `string` | `status` | Required key |
| `Trigger` | `map[string]interface{}` | `trigger` | Required key; nil becomes `null` |
| `Steps` | `int` | `steps` | Required key |
| `SuccessRate` | `float64` | `successRate` | Required key |
| `LastRunAt` | `*time.Time` | `lastRunAt` | Required key; nil becomes `null` |
| `PublishedVersion` | `int` | `publishedVersion` | Required key |
| `DraftVersion` | `int` | `draftVersion` | Required key |
| `Tags` | `[]string` | `tags` | Required key; nil becomes `null` |
| `DomainTags` | `[]string` | `domainTags` | Required key; nil becomes `null` |
| `CanRun` | `bool` | `canRun` | Required key |
| `YAML` | `string` | — | Never serialized |
| `Canvas` | `WorkflowCanvas` | — | Never serialized |
| `CreatedAt` | `time.Time` | `createdAt` | Required key |
| `UpdatedAt` | `time.Time` | `updatedAt` | Required key |
| `Archived` | `bool` | — | Never serialized |

Literal JSON shape:

```json
{
  "id": "wf_1", "name": "Monthly attendance review", "description": "Fetch and summarize",
  "owner": {"id": "usr_1", "name": "Operator"}, "assignedUserIds": ["usr_2"],
  "status": "DONE", "trigger": {"type": "manual"}, "steps": 2,
  "successRate": 100, "lastRunAt": "2026-08-22T10:00:00Z",
  "publishedVersion": 1, "draftVersion": 2, "tags": ["hr"], "domainTags": ["hr"],
  "canRun": true, "createdAt": "2026-08-20T08:00:00Z", "updatedAt": "2026-08-22T10:00:00Z"
}
```

`WorkflowVersion` fields are `ID string`→`id`, `WorkflowID string`→`workflowId`, `Version int`→`version`, `VersionNote string`→`versionNote`, `YAML string`→`yaml,omitempty`, `CreatedAt time.Time`→`createdAt`, and `CreatedBy Principal`→`createdBy`; only `yaml` can be omitted. [backend/internal/models/workflow.go:114-122](../../backend/internal/models/workflow.go)

```json
{"id":"ver_1","workflowId":"wf_1","version":1,"versionNote":"Initial publish","yaml":"name: Monthly attendance review\n...","createdAt":"2026-08-22T10:00:00Z","createdBy":{"id":"usr_1","name":"Operator"}}
```

The workflow status constants are exactly `PENDING`, `RUNNING`, `DONE`, `FAILED`, `HEALING`, and `draft-unvalidated`. They share one untyped constant group; code reuses the uppercase values for execution and execution-step status rather than defining separate enum types. [backend/internal/models/workflow.go:8-16](../../backend/internal/models/workflow.go)

Supporting workflow boundary types are exact: `WorkflowYAML{WorkflowID string json:"workflowId"; Version int json:"version"; YAML string json:"yaml"; Checksum string json:"checksum"; UpdatedAt time.Time json:"updatedAt"}`, `WorkflowCanvas{WorkflowID string json:"workflowId"; Nodes []WorkflowNode json:"nodes"; Edges []WorkflowEdge json:"edges"; Viewport map[string]interface{} json:"viewport"}`, `WorkflowNode{ID,Label,Type string; Icon string json:"icon,omitempty"; Position map[string]float64; Status string; Config map[string]interface{}}`, `WorkflowEdge{ID,Source,Target,Type string; Label *string json:"label"}`, and `WorkflowTemplate{ID,Name,Description,Category string; Tags []string; YAML string; Steps int; CreatedAt time.Time}` with the JSON keys shown by their lower-camel tags. [backend/internal/models/workflow.go:81-133](../../backend/internal/models/workflow.go)

```json
{
  "yamlRecord": {"workflowId":"wf_1","version":2,"yaml":"name: ...","checksum":"sha256:...","updatedAt":"2026-08-22T10:00:00Z"},
  "canvas": {"workflowId":"wf_1","nodes":[{"id":"n1","label":"Fetch","type":"tool","position":{"x":10,"y":20},"status":"idle","config":{}}],"edges":[{"id":"e1","source":"n1","target":"n2","type":"default","label":null}],"viewport":{"x":0,"y":0,"zoom":1}},
  "template": {"id":"tpl_1","name":"Attendance","description":"Template","category":"HR","tags":["hr"],"yaml":"name: ...","steps":2,"createdAt":"2026-08-22T10:00:00Z"}
}
```

## Execution, steps, and logs

`Execution` fields are exact. [backend/internal/models/state.go:38-56](../../backend/internal/models/state.go)

| Field | Go type | JSON key | Optional |
|---|---|---|---|
| `ID` | `string` | `id` | No |
| `WorkflowID` | `string` | `workflowId` | No |
| `WorkflowName` | `string` | `workflowName` | No |
| `Status` | `string` | `status` | No |
| `StartedAt` | `time.Time` | `startedAt` | No |
| `CompletedAt` | `*time.Time` | `completedAt` | No; null when running/unset |
| `DurationMS` | `int64` | `durationMs` | No |
| `Tokens` | `Tokens` | `tokens` | No |
| `CostUSD` | `float64` | `costUsd` | No |
| `StartedBy` | `Principal` | `startedBy` | No |
| `Failure` | `*ExecutionFailure` | `failure` | Yes |
| `StepOutputs` | `map[string]interface{}` | `stepOutputs` | Yes |
| `FinalOutput` | `interface{}` | `finalOutput` | Yes (nil omitted) |

`Tokens` is `{Input int json:"input", Output int json:"output", Total int json:"total"}`. `ExecutionFailure` is `{FailureCategory string json:"failureCategory", FailedStepID string json:"failedStepId", FailedToolName string json:"failedToolName", RuleID string json:"ruleId,omitempty", RuleMessage string json:"ruleMessage,omitempty", BlockedParameter string json:"blockedParameter,omitempty", ToolWasCalled bool json:"toolWasCalled"}`. [backend/internal/models/api.go:89-93](../../backend/internal/models/api.go) [backend/internal/models/state.go:28-36](../../backend/internal/models/state.go)

```json
{
  "id":"exec_1","workflowId":"wf_1","workflowName":"Monthly attendance review","status":"FAILED",
  "startedAt":"2026-08-22T10:00:00Z","completedAt":"2026-08-22T10:00:01Z","durationMs":1000,
  "tokens":{"input":0,"output":0,"total":0},"costUsd":0,
  "startedBy":{"id":"usr_1","name":"Operator"},
  "failure":{"failureCategory":"POLICY_VIOLATION","failedStepId":"fetch","failedToolName":"fetch_attendance","ruleId":"RULE-1","ruleMessage":"Amount exceeds policy","blockedParameter":"amount","toolWasCalled":false},
  "stepOutputs":{},"finalOutput":null
}
```

`ExecutionStep` is exact: `ID string`→`id`, `NodeID string`→`nodeId`, `Label string`→`label`, `Status string`→`status`, `StartedAt time.Time`→`startedAt`, `CompletedAt *time.Time`→`completedAt` (not optional; null when unset), `DurationMS *int64`→`durationMs` (not optional; null when unset), `Failure *ExecutionFailure`→`failure,omitempty`, `SideEffect *bool`→`sideEffect,omitempty`, and `Output interface{}`→`output,omitempty`. [backend/internal/models/state.go:68-79](../../backend/internal/models/state.go)

```json
{"id":"step_1","nodeId":"fetch","label":"fetch_attendance","status":"DONE","startedAt":"2026-08-22T10:00:00Z","completedAt":"2026-08-22T10:00:01Z","durationMs":1000,"sideEffect":false,"output":{"records":[]}}
```

`ExecutionLog` is exact: `ID string`→`id`, `ExecutionID string`→`executionId`, `Timestamp time.Time`→`timestamp`, `Level string`→`level`, `NodeID string`→`nodeId`, `Message string`→`message`, and `Metadata map[string]interface{}`→`metadata`; no key is optional and a nil metadata map emits `null`. [backend/internal/models/state.go:58-66](../../backend/internal/models/state.go)

```json
{"id":"log_1","executionId":"exec_1","timestamp":"2026-08-22T10:00:00Z","level":"info","nodeId":"fetch","message":"Step completed","metadata":{"durationMs":1000}}
```

Execution failure categories are exactly `POLICY_VIOLATION`, `TOOL_FAILURE`, `VALIDATION_FAILURE`, `INVALID_REQUEST`, `AUTH_DENIED`, `NOT_FOUND`, and `TRANSIENT`. [backend/internal/models/state.go:12-23](../../backend/internal/models/state.go)

`RunWorkflowRequest` is `{Input map[string]interface{} json:"input", Mode string json:"mode", DryRun bool json:"dryRun", IdempotencyKey string json:"idempotencyKey"}`; every key is non-omitempty, but no validation tags exist, so absent keys decode to nil/empty/false. [backend/internal/models/state.go:90-95](../../backend/internal/models/state.go)

## Full-gate result, validation token, and deferred check

`CandidateValidationResult` has `CandidateID string`→`candidate_id`, `Passed bool`→`passed`, `Score float64`→`score`, booleans `SchemaOK`, `ToolValidityOK`, `ParametersOK`, `RBACOK`, `PolicyOK`, `ProcessOrderOK`, `RiskOK` mapped to their snake-case names, `Errors []string`→`errors`, `Warnings []string`→`warnings`, `FailedRules []string`→`failed_rules`, `RegistryVersions RegistryVersions`→`registry_versions`, `EstimatedRisk string`→`estimated_risk_level`, `StepCount int`→`step_count`, hidden `ParsedWorkflow *WorkflowBlueprint`, optional `ToolRisks map[string]string`→`tool_risks`, optional `Metadata map[string]interface{}`→`metadata`, and optional `DeferredChecks []DeferredCheck`→`deferred_checks`. [backend/internal/core/validator/registry_validator.go:24-45](../../backend/internal/core/validator/registry_validator.go)

```json
{"candidate_id":"CreateWorkflow","passed":true,"score":1,"schema_ok":true,"tool_validity_ok":true,"parameters_ok":true,"rbac_ok":true,"policy_ok":true,"process_order_ok":true,"risk_ok":true,"errors":[],"warnings":[],"failed_rules":[],"registry_versions":{"tools":"sha256:...","rules":"sha256:..."},"estimated_risk_level":"low","step_count":2,"tool_risks":{"fetch_attendance":"low"},"metadata":{},"deferred_checks":[{"step_index":0,"param_key":"amount","rule_ids":["RULE-1"]}]}
```

`ValidationToken` is `{WorkflowContentHash string json:"workflow_content_hash", RegistryHash string json:"registry_hash", PassedAt time.Time json:"passed_at", DeferredChecks []DeferredCheck json:"deferred_checks", Proof string json:"-"}`. `DeferredCheck` is `{StepIndex int json:"step_index", ParamKey string json:"param_key", RuleIDs []string json:"rule_ids"}`. None of the serialized token/check keys are optional; `Proof` is process-internal and is never serialized. [backend/internal/models/validation_token.go:5-21](../../backend/internal/models/validation_token.go)

```json
{"workflow_content_hash":"sha256:...","registry_hash":"sha256:...","passed_at":"2026-08-22T10:00:00Z","deferred_checks":[{"step_index":0,"param_key":"amount","rule_ids":["RULE-1"]}]}
```

The zero token is invalid: nil, blank proof, or a proof that does not verify returns false. A token is constructed only after a passing full-gate result. [backend/internal/core/validator/registry_validator.go:77-106](../../backend/internal/core/validator/registry_validator.go) [backend/internal/core/validator/registry_validator.go:109-125](../../backend/internal/core/validator/registry_validator.go)

## Dispatch capability

`DispatchCapability` is not a JSON DTO. Its exact fields are unexported: `proof dispatchProof`, `workflowContentHash string`, `registryHash string`, `stepIndex int`, `action string`, and `resolvedParameterHash string`; `dispatchProof` contains the unexported `minted bool`. External Go packages can read only through `WorkflowContentHash()`, `RegistryHash()`, `StepIndex()`, `Action()`, and `ResolvedParameterHash()`. [backend/internal/core/validator/dispatch_capability.go:13-45](../../backend/internal/core/validator/dispatch_capability.go)

Encoding a capability with `encoding/json` produces `{}` because it has no exported fields. Its zero value is unusable. `IsUsable()` requires minted proof, nonblank workflow/registry/action/parameter hashes, and a nonnegative step index. [backend/internal/core/validator/dispatch_capability.go:21-37](../../backend/internal/core/validator/dispatch_capability.go)

```json
{}
```

## Tool definition, rule, and registries

`registry.Tool` is the external registry definition. [backend/internal/core/registry/models.go:3-33](../../backend/internal/core/registry/models.go)

| Go field | JSON key | Go type | Optional |
|---|---|---|---|
| `ToolID` | `tool_id` | `string` | No |
| `Name` | `name` | `string` | No |
| `DisplayName` | `display_name` | `string` | No |
| `ERPSystem` | `erp_system` | `string` | Yes |
| `Module` | `module` | `string` | No |
| `Status` | `status` | `string` | No |
| `Description` | `description` | `string` | No |
| `BusinessCapability` | `business_capability` | `string` | No |
| `BPIProcessAlignment` | `bpi_process_alignment` | `[]string` | No |
| `Endpoint` | `endpoint` | `string` | No |
| `HTTPMethod` | `http_method` | `string` | No |
| `MCPToolName` | `mcp_tool_name` | `string` | No |
| `InputSchema` | `input_schema` | `map[string]interface{}` | No |
| `RequiredParameters` | `required_parameters` | `[]string` | No |
| `OptionalParameters` | `optional_parameters` | `[]string` | No |
| `AllowedRoles` | `allowed_roles` | `[]string` | No |
| `RiskLevel` | `risk_level` | `string` | No |
| `IsReadOnly` | `is_read_only` | `bool` | No |
| `SideEffects` | `side_effects` | `[]string` | No |
| `Preconditions` | `preconditions` | `[]string` | No |
| `Postconditions` | `postconditions` | `[]string` | No |
| `FailureModes` | `failure_modes` | `[]string` | No |
| `ValidatorChecks` | `validator_checks` | `[]string` | No |
| `PromptUsageGuidance` | `prompt_usage_guidance` | `string` | No |
| `SemanticSearchKeywords` | `semantic_search_keywords` | `[]string` | No |
| `SemanticSearchDescription` | `semantic_search_description` | `string` | No |
| `ExecutionNotes` | `execution_notes` | `string` | No |
| `CurrentGaps` | `current_gaps` | `[]string` | No |
| `SourceFile` | `source_file` | `string` | Yes |

```json
{"tool_id":"TOOL-HR-1","name":"fetch_attendance","display_name":"Fetch attendance","erp_system":"ERP","module":"hr","status":"active_mcp_schema_present","description":"Fetch attendance records","business_capability":"Attendance","bpi_process_alignment":["manage attendance"],"endpoint":"/attendance","http_method":"POST","mcp_tool_name":"fetch_attendance","input_schema":{"type":"object"},"required_parameters":["employee_id"],"optional_parameters":[],"allowed_roles":["Workflow Builder"],"risk_level":"low","is_read_only":true,"side_effects":[],"preconditions":[],"postconditions":[],"failure_modes":[],"validator_checks":[],"prompt_usage_guidance":"Use for attendance retrieval","semantic_search_keywords":["attendance"],"semantic_search_description":"Attendance lookup","execution_notes":"","current_gaps":[]}
```

`RuleCondition` is `{Type string json:"type", Parameter string json:"parameter", Operator string json:"operator", Value interface{} json:"value"}`; all four keys are always emitted. `Rule` fields are exact below. [backend/internal/core/registry/models.go:35-61](../../backend/internal/core/registry/models.go)

| Go field | JSON key | Go type | Optional |
|---|---|---|---|
| `RuleID` | `rule_id` | `string` | No |
| `RuleName` | `rule_name` | `string` | No |
| `RuleType` | `rule_type` | `string` | No |
| `ERPSystem` | `erp_system` | `string` | Yes |
| `Domain` | `domain` | `string` | No |
| `Description` | `description` | `string` | No |
| `AppliesToTools` | `applies_to_tools` | `[]string` | No |
| `AppliesToRoles` | `applies_to_roles` | `[]string` | No |
| `Condition` | `condition` | `RuleCondition` | No |
| `EnforcementAction` | `enforcement_action` | `string` | No |
| `Severity` | `severity` | `string` | No |
| `ValidatorMessage` | `validator_message` | `string` | No |
| `LLMPromptInstruction` | `llm_prompt_instruction` | `string` | No |
| `HealingGuidance` | `healing_guidance` | `string` | No |
| `BPIAlignment` | `bpi_alignment` | `[]string` | No |
| `AuditFieldsRequired` | `audit_fields_required` | `[]string` | No |
| `Enabled` | `enabled` | `bool` | No |
| `SourceFile` | `source_file` | `string` | Yes |

```json
{"rule_id":"RULE-1","rule_name":"Approval threshold","rule_type":"amount_threshold","domain":"finance","description":"Require approval above threshold","applies_to_tools":["create_invoice"],"applies_to_roles":["Workflow Builder"],"condition":{"type":"threshold","parameter":"amount","operator":">","value":10000},"enforcement_action":"block","severity":"high","validator_message":"Approval is required","llm_prompt_instruction":"Add approval before posting","healing_guidance":"Insert approval step","bpi_alignment":["approve invoice"],"audit_fields_required":["amount"],"enabled":true}
```

`RegistryVersions` is `{Tools string json:"tools", Rules string json:"rules", Templates string json:"templates,omitempty", Examples string json:"examples,omitempty"}`. `Bundle` is an internal aggregate with `Tools *ToolRegistry`, `Rules *RuleRegistry`, `Templates []ProcessTemplate`, `Examples []FewShotExample`, and `Versions RegistryVersions`; it has no JSON tags and is not itself returned directly. [backend/internal/core/registry/models.go:94-99](../../backend/internal/core/registry/models.go) [backend/internal/core/registry/loader.go:16-22](../../backend/internal/core/registry/loader.go)

```json
{"tools":"sha256:0123456789abcdef","rules":"sha256:fedcba9876543210","templates":"sha256:...","examples":"sha256:..."}
```

`ToolRegistry` and `RuleRegistry` have only unexported storage/locks/version fields, so direct JSON encoding yields `{}`; callers cross the package boundary through copied snapshots and version methods. Tool lookup normalizes by lowercasing and trimming names/IDs/MCP names. [backend/internal/core/registry/tool_registry.go:8-14](../../backend/internal/core/registry/tool_registry.go) [backend/internal/core/registry/tool_registry.go:61-107](../../backend/internal/core/registry/tool_registry.go) [backend/internal/core/registry/rule_registry.go:8-13](../../backend/internal/core/registry/rule_registry.go)

## Tool call request and response

The remote MCP request is an anonymous wire struct with `Action string json:"action"` and `Parameters json.RawMessage json:"parameters"`; the parameter raw message is the exact JSON serialization previously hashed for the capability check. The response is decoded into `map[string]interface{}` with no schema validation. [backend/internal/tools/mcp_client.go:62-120](../../backend/internal/tools/mcp_client.go)

```json
{"action":"fetch_attendance","parameters":{"employee_id":"emp_1"}}
```

```json
{"records":[{"date":"2026-08-21","status":"present"}],"count":1}
```

The package-level `ToolResult`, where used as a DTO, is `{Action string json:"action", Result map[string]interface{} json:"result"}`. [backend/internal/tools/tool_interface.go:15-18](../../backend/internal/tools/tool_interface.go)

```json
{"action":"fetch_attendance","result":{"records":[]}}
```

`MCPMode` values are exactly `"remote"` and `"mock"`; its zero value `""` is rejected by `SetMode`, although a newly constructed client initializes to remote. [backend/internal/tools/mcp_client.go:15-20](../../backend/internal/tools/mcp_client.go) [backend/internal/tools/mcp_client.go:41-59](../../backend/internal/tools/mcp_client.go)

## User, role, permission, and audit record

`User` fields are exact. [backend/internal/models/user.go:10-30](../../backend/internal/models/user.go)

| Go field | JSON key | Go type | Optional / hidden |
|---|---|---|---|
| `ID` | `id` | `string` | No |
| `Name` | `name` | `string` | No |
| `Email` | `email` | `string` | No |
| `RoleID` | `roleId` | `string` | No |
| `PermissionOverrides` | `permissionOverrides` | `[]string` | No |
| `Status` | `status` | `string` | No |
| `Initials` | `initials` | `string` | No |
| `Timezone` | `timezone` | `string` | Yes |
| `DepartmentID` | `departmentId` | `*string` | No; nil emits null |
| `LastLoginAt` | `lastLoginAt` | `*time.Time` | No; nil emits null |
| `CreatedAt` | `createdAt` | `time.Time` | No |
| `TwoFactorEnabled` | `twoFactorEnabled` | `bool` | Yes when false |
| `EmailVerified` | `emailVerified` | `bool` | Yes when false |
| `Role` | — | `RoleRef` | Never serialized |
| `Permissions` | — | `[]string` | Never serialized |

```json
{"id":"usr_1","name":"Operator","email":"operator@example.com","roleId":"role_builder","permissionOverrides":[],"status":"Active","initials":"OP","timezone":"UTC","departmentId":null,"lastLoginAt":null,"createdAt":"2026-08-22T10:00:00Z"}
```

`AssignedRoleID()` returns empty for a nil user, otherwise prefers nonempty `RoleID`, then falls back to the hidden legacy `Role.ID`. [backend/internal/models/user.go:32-42](../../backend/internal/models/user.go)

`Role` is `{ID string json:"id", Name string json:"name", Description string json:"description", Permissions []string json:"permissions", CreatedAt time.Time json:"createdAt"}`. `Permission` is `{Key string json:"key", Name string json:"name", Description string json:"description", Group string json:"group"}`. `RoleRef` is `{ID string json:"id", Name string json:"name"}`. [backend/internal/models/user.go:5-8](../../backend/internal/models/user.go) [backend/internal/models/user.go:44-57](../../backend/internal/models/user.go)

```json
{"role":{"id":"role_builder","name":"Workflow Builder","description":"Build workflows","permissions":["workflow:read","workflow:write","workflow:run"],"createdAt":"2026-08-22T10:00:00Z"},"permission":{"key":"workflow:run","name":"Run workflows","description":"Start, cancel, and retry workflow executions","group":"Execution"}}
```

Built-in role IDs are exactly `role_admin`, `role_system_admin`, `role_builder`, and `role_client`. [backend/internal/repository/memory.go:14-19](../../backend/internal/repository/memory.go)

`AuditLog` is `{ID string json:"id", Actor Principal json:"actor", Action string json:"action", Resource ResourceRef json:"resource", IPAddress string json:"ipAddress", UserAgent string json:"userAgent", Before map[string]interface{} json:"before", After map[string]interface{} json:"after", CreatedAt time.Time json:"createdAt"}`; no key is optional and nil maps emit null. `Principal` is `{ID,Name string}` under `id`,`name`; `ResourceRef` is `{Type,ID string}` under `type`,`id`. [backend/internal/models/user.go:59-69](../../backend/internal/models/user.go) [backend/internal/models/api.go:46-54](../../backend/internal/models/api.go)

```json
{"id":"audit_1","actor":{"id":"usr_1","name":"Operator"},"action":"workflow.created","resource":{"type":"workflow","id":"wf_1"},"ipAddress":"127.0.0.1","userAgent":"client","before":null,"after":{"status":"PENDING"},"createdAt":"2026-08-22T10:00:00Z"}
```

## Chat session and message

`ChatSession` is `{ID string json:"id", OwnerID string json:"ownerId", Title string json:"title", CreatedAt time.Time json:"createdAt", UpdatedAt time.Time json:"updatedAt", MessageCount int json:"messageCount"}`. `ChatMessage` is `{ID string json:"id", Role string json:"role", Text string json:"text", Artifacts map[string]interface{} json:"artifacts,omitempty", CreatedAt time.Time json:"createdAt"}`. `ChatSessionDetail` anonymously embeds `ChatSession` (its keys flatten into the containing object) and adds `Messages []ChatMessage json:"messages"`. [backend/internal/models/settings.go:44-64](../../backend/internal/models/settings.go)

```json
{"id":"chat_1","ownerId":"usr_1","title":"Attendance workflow","createdAt":"2026-08-22T10:00:00Z","updatedAt":"2026-08-22T10:01:00Z","messageCount":1,"messages":[{"id":"msg_1","role":"user","text":"Build an attendance workflow","artifacts":{"workflowId":"wf_1"},"createdAt":"2026-08-22T10:01:00Z"}]}
```

No enum type constrains `ChatMessage.Role`; handlers write literal role values, so consumers must not assume compile-time enforcement. The struct itself accepts any string. [backend/internal/models/settings.go:53-59](../../backend/internal/models/settings.go)

## API success/error envelope and auth DTOs

`APIResponse` is always `{Success bool json:"success", Data interface{} json:"data", Message string json:"message", Meta interface{} json:"meta"}`. `OK` substitutes message `"OK"` when passed blank; `Fail` substitutes `"Request failed"`, sets data to nil, and leaves meta as supplied. No envelope key is optional. [backend/internal/models/api.go:5-36](../../backend/internal/models/api.go)

```json
{"success":true,"data":{"id":"wf_1"},"message":"OK","meta":null}
```

```json
{"success":false,"data":null,"message":"Request failed","meta":{"field":"yaml"}}
```

`LoginRequest` is `{Email string json:"email" validate:"required,email", Password string json:"password" validate:"required", RememberMe bool json:"rememberMe"}`. `RegisterRequest` is `{Name string json:"name" validate:"required", Email string json:"email" validate:"required,email", Password string json:"password" validate:"required,min=8", OrganizationName string json:"organizationName"}`. Their tags are not invoked by `parseBody`; login manually requires nonblank email/password but does not perform the tag's email syntax check, while registration manually requires name/email nonblank and password length at least eight but likewise does not validate email syntax. [backend/internal/models/api.go:56-67](../../backend/internal/models/api.go) [backend/internal/api/handlers/auth_handler.go:17-25](../../backend/internal/api/handlers/auth_handler.go) [backend/internal/api/handlers/auth_handler.go:72-81](../../backend/internal/api/handlers/auth_handler.go)

```json
{"email":"operator@example.com","password":"[REDACTED]","rememberMe":false}
```

`TokenPair` is `{AccessToken string json:"accessToken", RefreshToken string json:"refreshToken", ExpiresIn int json:"expiresIn"}`. `AuthSession` has the same three fields plus `User interface{} json:"user"`. No field is optional. [backend/internal/models/api.go:69-80](../../backend/internal/models/api.go)

```json
{"accessToken":"[REDACTED]","refreshToken":"[REDACTED]","expiresIn":3600,"user":{"id":"usr_1","name":"Operator"}}
```

`PaginationMeta` is `{Page int json:"page", Limit int json:"limit", Total int json:"total", TotalPages int json:"totalPages", Sort string json:"sort,omitempty"}`. [backend/internal/models/api.go:38-44](../../backend/internal/models/api.go)

## Additional boundary DTOs

- Validation DTOs: `ValidationIssue{Code string json:"code", Message string json:"message", NodeID string json:"nodeId,omitempty"}`, `ValidationCheck{Name string json:"name", Passed bool json:"passed"}`, and `ValidationResult{Valid bool json:"valid", Score float64 json:"score", Errors []ValidationIssue json:"errors", Warnings []ValidationIssue json:"warnings", Checks []ValidationCheck json:"checks"}`. [backend/internal/models/api.go:95-112](../../backend/internal/models/api.go)
- Usage DTOs: `Usage{InputTokens int json:"inputTokens", OutputTokens int json:"outputTokens", TotalTokens int json:"totalTokens,omitempty", CostUSD float64 json:"costUsd"}`; only zero `TotalTokens` is omitted. [backend/internal/models/api.go:82-87](../../backend/internal/models/api.go)
- `UploadedFile{ID,Name,MimeType string; SizeBytes int64; URL,Checksum string; CreatedAt time.Time}` maps to `id,name,mimeType,sizeBytes,url,checksum,createdAt` with no optional keys. [backend/internal/models/api.go:114-122](../../backend/internal/models/api.go)
- `ProviderConfig{ID,Name,Type string; BaseURL string json:"baseUrl,omitempty"; Model string; Temperature float64; APIKey string json:"-"; Active bool; CreatedAt time.Time}` maps the remaining fields to `id,name,type,model,temperature,active,createdAt`; the secret value never serializes. [backend/internal/models/settings.go:11-21](../../backend/internal/models/settings.go)
- `Integration{ID,Name,Type,Status,Icon string; Config map[string]interface{}; LastTestedAt *time.Time; CreatedAt time.Time}` maps to `id,name,type,status,icon,config,lastTestedAt,createdAt`; nil last-test time emits `null`. `Webhook{ID,Name,URL string; Events []string; Enabled bool; SecretPreview string; CreatedAt time.Time}` maps to `id,name,url,events,enabled,secretPreview,createdAt`. [backend/internal/models/settings.go:23-42](../../backend/internal/models/settings.go)
- `SettingsBundle` has nonoptional `general`, `llm`, and `rbac` maps. `NotificationPreferences` has nonoptional booleans `executionFailures`, `healingEvents`, `budgetWarnings`, `weeklyReports`, plus `channels map[string]bool`. `APIKey` hides `Key`; the public shape is `id,name,maskedKey,scopes,createdAt,expiresAt`, with nil expiry emitted as null. `Notification` is `id,message,tone,type,read,resource,createdAt`. [backend/internal/models/settings.go:5-9](../../backend/internal/models/settings.go) [backend/internal/models/user.go:81-107](../../backend/internal/models/user.go)
- `HealingReport` is `{ExecutionID string json:"executionId", WorkflowID string json:"workflowId", Status string json:"status", Summary string json:"summary", Events []map[string]interface{} json:"events", Metrics map[string]interface{} json:"metrics"}`. [backend/internal/models/state.go:81-88](../../backend/internal/models/state.go)
- Company boundary types are `company.Profile` with `name,legalName,industry,timezone,currency,fiscalYearStart,contactEmail,erpSystemName,erpVersion,notes,departments,costCentres,approvalTiers`; `Department{id,name,domains}`, `CostCentre{code,name,ownerUserId,budgetAmount,currency}`, and `ApprovalTier{label,maxAmount,approverRoleId}`. No key is optional. Empty stored payload or a fully zero profile decodes to timezone `UTC`, currency `USD`, and empty arrays. [backend/internal/core/company/models.go:14-58](../../backend/internal/core/company/models.go) [backend/internal/core/company/models.go:68-79](../../backend/internal/core/company/models.go)
- Import boundary enums are `SourceKind`: `tools`, `rules`, `openapi`; and `StageName`: `PARSE`, `NORMALISE`, `VALIDATE`, `DIFF`, `CONFIRM`, `COMMIT`. Their result shapes (`StageResult`, `RecordError`, `FieldChange`, `ImportRecord`, `Preview`, `Analysis`, `CommitResult`, `HistoryEntry`) and exact JSON tags are declared together; internal-only `AnalyseInput` and `CommitOptions` have no JSON tags. [backend/internal/core/importer/models.go:9-116](../../backend/internal/core/importer/models.go)
- Orchestration output is `CandidateReport{candidate_id,yaml,generation_metadata,validation}`, `ValidationSummary{passed_candidates,blocked_candidates,best_score}`, and `ChatResponse{session_id,assistant_message,retrieval,candidates,selected_candidate_id,selected_workflow_yaml,can_execute,validation_summary,blocking_errors?,next_action?}`; `RawCandidates` is hidden. `ChatRequest` is an internal call object with no JSON tags. [backend/internal/core/orchestrator/orchestration_models.go:9-47](../../backend/internal/core/orchestrator/orchestration_models.go)
- Semantic search result embeds complete registry definitions and adds `score` and `match_reason`; the top-level result keys are `tools,rules,global_rules,templates,examples,query,user_role,method?,retrieval_method`. [backend/internal/core/semanticsearch/models.go:13-47](../../backend/internal/core/semanticsearch/models.go)

Representative additional JSON:

```json
{
  "validation":{"valid":false,"score":0.3,"errors":[{"code":"SCHEMA_INVALID","message":"YAML failed schema validation"}],"warnings":[],"checks":[{"name":"Schema valid","passed":false}]},
  "provider":{"id":"provider_1","name":"Provider","type":"openai-compatible","baseUrl":"https://provider.example/v1","model":"model-1","temperature":0.2,"active":true,"createdAt":"2026-08-22T10:00:00Z"},
  "healing":{"executionId":"exec_1","workflowId":"wf_1","status":"FAILED","summary":"Repair did not validate","events":[],"metrics":{}},
  "company":{"name":"Example Co","legalName":"Example Co Ltd","industry":"Services","timezone":"Asia/Colombo","currency":"LKR","fiscalYearStart":"01-01","contactEmail":"ops@example.com","erpSystemName":"ERP","erpVersion":"1","notes":"","departments":[],"costCentres":[],"approvalTiers":[]}
}
```

## Complete enum/value inventory crossing boundaries

- Workflow/execution statuses: `PENDING`, `RUNNING`, `DONE`, `FAILED`, `HEALING`, `draft-unvalidated`; step kinds: `tool`, `analysis`. [backend/internal/models/workflow.go:8-17](../../backend/internal/models/workflow.go)
- Execution failure categories: `POLICY_VIOLATION`, `TOOL_FAILURE`, `VALIDATION_FAILURE`, `INVALID_REQUEST`, `AUTH_DENIED`, `NOT_FOUND`, `TRANSIENT`. [backend/internal/models/state.go:15-23](../../backend/internal/models/state.go)
- MCP modes: `remote`, `mock`; detected mock-backend kind: `mock-erp`. [backend/internal/tools/mcp_client.go:15-20](../../backend/internal/tools/mcp_client.go) [backend/internal/config/mcp_backend.go:13-20](../../backend/internal/config/mcp_backend.go)
- Rule evaluator status: `EVALUATED`, `NO_EVALUATOR`. The known rule-family classification keys are `amount_threshold`, `audit`, `capability_gap`, `cache_safety`, `data_confidentiality`, `execution_safety`, `parameter_required`, `process_order`, `quantity_threshold`, `rbac`, `risk_escalation`, and `separation_of_duties`; unknown family strings classify as `NO_EVALUATOR`. [backend/internal/core/validator/rule_evaluators.go:8-48](../../backend/internal/core/validator/rule_evaluators.go)
- Import source/stage values: `tools`, `rules`, `openapi`; `PARSE`, `NORMALISE`, `VALIDATE`, `DIFF`, `CONFIRM`, `COMMIT`. [backend/internal/core/importer/models.go:9-26](../../backend/internal/core/importer/models.go)
- Built-in role IDs: `role_admin`, `role_system_admin`, `role_builder`, `role_client`. [backend/internal/repository/memory.go:14-19](../../backend/internal/repository/memory.go)

Tool status, risk level, rule type, enforcement action, severity, user status, chat role, webhook/integration status, and message/log level are plain strings rather than Go enums. Their admissible values are therefore not constrained by the type definitions; registry validation and individual handlers may impose contextual checks described in later sections. [backend/internal/core/registry/models.go:3-61](../../backend/internal/core/registry/models.go) [backend/internal/models/user.go:10-23](../../backend/internal/models/user.go) [backend/internal/models/settings.go:23-59](../../backend/internal/models/settings.go)
