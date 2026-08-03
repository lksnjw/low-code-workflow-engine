---
registry_hash: sha256:b97e02928fdfe1c4403488a48cc86a2557cd77e461aa02bbfe017318218152ca
tool_registry_sha256: b52580de94d9d3e73414398c313847942925c5ff2613e470d2cca27d14ee83cc
rule_registry_sha256: 00850f19cfd8b29cb9dbe4aa820c474eae9a2bbc7f6fd710ba4b686c65c83a26
generated_at: "2026-08-03T03:00:17Z"
tool_count: 22
rule_count: 12
generator_version: 1
---
<!-- registry_sha256: sha256:b97e02928fdfe1c4403488a48cc86a2557cd77e461aa02bbfe017318218152ca -->

# Runtime Registry Generation Context

## 1. DOMAIN INDEX

- **approval** — 1 active tool(s)
- **audit** — 1 active tool(s)
- **capability** — 1 active tool(s)
- **demo** — 4 active tool(s)
- **finance** — 3 active tool(s)
- **governance** — 1 active tool(s)
- **hr** — 2 active tool(s)
- **integration** — 2 active tool(s)
- **inventory** — 1 active tool(s)
- **logistics** — 2 active tool(s)
- **notification** — 1 active tool(s)
- **policy** — 1 active tool(s)
- **procurement** — 2 active tool(s)

## 2. TOOL CATALOGUE

### approval

#### `approval.request_human_approval`

- **DisplayName:** Request Human Approval
- **Description:** Creates a human approval request for high-risk or policy-controlled workflows.
- **BusinessCapability:** Human approval
- **InputSchema parameters:** none
- **RequiredParameters:** `approval_reason`, `approver_role`
- **OptionalParameters:** `amount`, `quantity`, `workflow_id`
- **AllowedRoles:** `admin`, `department_manager`, `finance_manager`, `Platform Admin`, `procurement_manager`, `Workflow Builder`
- **RiskLevel:** medium
- **IsReadOnly:** false
- **SideEffects:** `Creates an approval task.`
- **PromptUsageGuidance:** 

### audit

#### `audit.write_audit_log`

- **DisplayName:** Write Audit Log
- **Description:** Writes an audit log event for workflow validation and execution decisions.
- **BusinessCapability:** Audit logging
- **InputSchema parameters:** none
- **RequiredParameters:** `actor_role`, `decision`, `event_type`
- **OptionalParameters:** `workflow_id`
- **AllowedRoles:** `admin`, `Auditor`, `employee`, `Execution Reviewer`, `finance_editor`, `Platform Admin`, `procurement_officer`, `Workflow Builder`
- **RiskLevel:** low
- **IsReadOnly:** false
- **SideEffects:** `Writes audit evidence.`
- **PromptUsageGuidance:** 

### capability

#### `capability.create_capability_request`

- **DisplayName:** Create Capability Request
- **Description:** Creates a capability gap request when a tool or schema does not exist.
- **BusinessCapability:** Capability request
- **InputSchema parameters:** none
- **RequiredParameters:** `business_reason`, `requested_capability`
- **OptionalParameters:** `requester_role`
- **AllowedRoles:** `admin`, `employee`, `Platform Admin`, `Workflow Builder`
- **RiskLevel:** low
- **IsReadOnly:** false
- **SideEffects:** `Creates capability request.`
- **PromptUsageGuidance:** 

### demo

#### `demo.context.generate`

- **DisplayName:** Registry Context Generation Demo
- **Description:** Verifies that a successful runtime import regenerates the Markdown generation context.
- **BusinessCapability:** Generation context lifecycle verification
- **InputSchema parameters:** `message` ("string")
- **RequiredParameters:** `message`
- **OptionalParameters:** none
- **AllowedRoles:** `Platform Admin`
- **RiskLevel:** low
- **IsReadOnly:** true
- **SideEffects:** none
- **PromptUsageGuidance:** Provide a short verification message.

#### `demo.echo`

- **DisplayName:** Demo Echo
- **Description:** Returns a deterministic echo result for the local governed demo flow.
- **BusinessCapability:** Safe local demonstration
- **InputSchema parameters:** `amount` ("number"), `message` ("string")
- **RequiredParameters:** `amount`, `message`
- **OptionalParameters:** none
- **AllowedRoles:** `Client`, `Platform Admin`, `Workflow Builder`
- **RiskLevel:** low
- **IsReadOnly:** true
- **SideEffects:** none
- **PromptUsageGuidance:** Use only for the documented local demo workflow.

#### `demo.ping`

- **DisplayName:** Demo Ping
- **Description:** Acceptance-run read-only ping tool.
- **BusinessCapability:** Safe local demonstration
- **InputSchema parameters:** `amount` ("number"), `message` ("string")
- **RequiredParameters:** `amount`, `message`
- **OptionalParameters:** none
- **AllowedRoles:** `Client`, `Platform Admin`, `Workflow Builder`
- **RiskLevel:** low
- **IsReadOnly:** true
- **SideEffects:** none
- **PromptUsageGuidance:** Use only for the documented local demo workflow.

#### `demo.registry.import`

- **DisplayName:** Runtime Registry Import Demo
- **Description:** Small deterministic tool used to verify runtime-only registry imports.
- **BusinessCapability:** Registry boundary demonstration
- **InputSchema parameters:** `message` ("string")
- **RequiredParameters:** `message`
- **OptionalParameters:** none
- **AllowedRoles:** `Platform Admin`
- **RiskLevel:** low
- **IsReadOnly:** false
- **SideEffects:** `Writes a demonstration record`
- **PromptUsageGuidance:** Provide a short message.

### finance

#### `classify_invoice`

- **DisplayName:** Classify Invoice
- **Description:** Classifies invoice-related user intent or invoice exception context.
- **BusinessCapability:** Invoice classification
- **InputSchema parameters:** none
- **RequiredParameters:** none
- **OptionalParameters:** `invoiceId`, `prompt`
- **AllowedRoles:** `admin`, `finance_editor`, `finance_manager`, `finance_viewer`, `Platform Admin`, `Workflow Builder`
- **RiskLevel:** low
- **IsReadOnly:** true
- **SideEffects:** none
- **PromptUsageGuidance:** 

#### `finance.clear_invoice`

- **DisplayName:** Clear Invoice
- **Description:** Clears an invoice after required receipt and matching evidence is present.
- **BusinessCapability:** Invoice clearing
- **InputSchema parameters:** none
- **RequiredParameters:** `invoice_id`
- **OptionalParameters:** `goods_receipt_id`, `purchase_order_id`
- **AllowedRoles:** `admin`, `finance_editor`, `finance_manager`, `Platform Admin`, `Workflow Builder`
- **RiskLevel:** critical
- **IsReadOnly:** false
- **SideEffects:** `Clears invoice for downstream payment.`
- **PromptUsageGuidance:** 

#### `finance.record_invoice_receipt`

- **DisplayName:** Record Invoice Receipt
- **Description:** Records invoice receipt before validation and clearing.
- **BusinessCapability:** Invoice receipt
- **InputSchema parameters:** none
- **RequiredParameters:** `invoice_id`
- **OptionalParameters:** `receipt_reference`
- **AllowedRoles:** `admin`, `finance_editor`, `finance_manager`, `Platform Admin`, `Workflow Builder`
- **RiskLevel:** medium
- **IsReadOnly:** false
- **SideEffects:** `Records invoice receipt.`
- **PromptUsageGuidance:** 

### governance

#### `policy_check`

- **DisplayName:** Policy Check
- **Description:** Checks a workflow intent or transaction against policy guardrails.
- **BusinessCapability:** Policy validation
- **InputSchema parameters:** none
- **RequiredParameters:** none
- **OptionalParameters:** `amount`, `intent`, `quantity`
- **AllowedRoles:** `admin`, `Auditor`, `employee`, `Execution Reviewer`, `finance_editor`, `Platform Admin`, `procurement_officer`, `Workflow Builder`
- **RiskLevel:** low
- **IsReadOnly:** true
- **SideEffects:** none
- **PromptUsageGuidance:** 

### hr

#### `create_leave`

- **DisplayName:** Create Leave
- **Description:** Creates a leave request through the MCP middleware.
- **BusinessCapability:** Leave request creation
- **InputSchema parameters:** none
- **RequiredParameters:** none
- **OptionalParameters:** `employeeId`, `end_date`, `leave_type`, `start_date`
- **AllowedRoles:** `admin`, `employee`, `hr_manager`, `Platform Admin`, `Workflow Builder`
- **RiskLevel:** medium
- **IsReadOnly:** false
- **SideEffects:** `Creates an HR leave request.`
- **PromptUsageGuidance:** 

#### `fetch_attendance`

- **DisplayName:** Fetch Attendance
- **Description:** Fetches employee attendance through the MCP middleware.
- **BusinessCapability:** Attendance lookup
- **InputSchema parameters:** none
- **RequiredParameters:** none
- **OptionalParameters:** `date_from`, `date_to`, `employeeId`
- **AllowedRoles:** `admin`, `hr_manager`, `hr_viewer`, `Platform Admin`, `Workflow Builder`
- **RiskLevel:** low
- **IsReadOnly:** true
- **SideEffects:** none
- **PromptUsageGuidance:** 

### integration

#### `refresh_connector`

- **DisplayName:** Refresh Connector
- **Description:** Refreshes an external connector through the MCP middleware.
- **BusinessCapability:** Connector repair
- **InputSchema parameters:** none
- **RequiredParameters:** none
- **OptionalParameters:** `connector_id`
- **AllowedRoles:** `admin`, `Platform Admin`, `Workflow Builder`
- **RiskLevel:** medium
- **IsReadOnly:** false
- **SideEffects:** `Refreshes connector state.`
- **PromptUsageGuidance:** 

#### `send_webhook`

- **DisplayName:** Send Webhook
- **Description:** Sends a webhook event to an integration endpoint.
- **BusinessCapability:** Webhook delivery
- **InputSchema parameters:** none
- **RequiredParameters:** `url`
- **OptionalParameters:** `payload`
- **AllowedRoles:** `admin`, `Platform Admin`, `Workflow Builder`
- **RiskLevel:** medium
- **IsReadOnly:** false
- **SideEffects:** `Sends external webhook.`
- **PromptUsageGuidance:** 

### inventory

#### `inventory.record_goods_receipt`

- **DisplayName:** Record Goods Receipt
- **Description:** Records goods receipt for a purchase order.
- **BusinessCapability:** Goods receipt
- **InputSchema parameters:** none
- **RequiredParameters:** `purchase_order_id`, `received_quantity`
- **OptionalParameters:** `item_id`
- **AllowedRoles:** `admin`, `inv_editor`, `Platform Admin`, `procurement_officer`, `Workflow Builder`
- **RiskLevel:** medium
- **IsReadOnly:** false
- **SideEffects:** `Records goods receipt.`
- **PromptUsageGuidance:** 

### logistics

#### `logistics.shipment.createshipment`

- **DisplayName:** Create Shipment
- **Description:** Creates a shipment record.
- **BusinessCapability:** Create Shipment
- **InputSchema parameters:** `carrier` ("string"), `weight_kg` ("number")
- **RequiredParameters:** `carrier`, `weight_kg`
- **OptionalParameters:** none
- **AllowedRoles:** `Client`, `Platform Admin`, `System Admin`, `Workflow Builder`
- **RiskLevel:** medium
- **IsReadOnly:** false
- **SideEffects:** `May change external state through POST /shipments.`
- **PromptUsageGuidance:** Use this operation only with the parameters declared by the imported OpenAPI contract.

#### `logistics.shipment.getshipment`

- **DisplayName:** Get Shipment
- **Description:** Reads one shipment by id.
- **BusinessCapability:** Get Shipment
- **InputSchema parameters:** `id` ("string")
- **RequiredParameters:** `id`
- **OptionalParameters:** none
- **AllowedRoles:** `Client`, `Platform Admin`, `System Admin`, `Workflow Builder`
- **RiskLevel:** low
- **IsReadOnly:** true
- **SideEffects:** none
- **PromptUsageGuidance:** Use this operation only with the parameters declared by the imported OpenAPI contract.

### notification

#### `notify_finance`

- **DisplayName:** Notify Finance
- **Description:** Sends a finance workflow notification.
- **BusinessCapability:** Finance notification
- **InputSchema parameters:** none
- **RequiredParameters:** `message`
- **OptionalParameters:** `recipient_id`
- **AllowedRoles:** `admin`, `finance_editor`, `finance_manager`, `Platform Admin`, `Workflow Builder`
- **RiskLevel:** medium
- **IsReadOnly:** false
- **SideEffects:** `Sends notification.`
- **PromptUsageGuidance:** 

### policy

#### `policy.check_policy_limit`

- **DisplayName:** Check Policy Limit
- **Description:** Checks amount, quantity, or request details against configured policy limits.
- **BusinessCapability:** Policy limit check
- **InputSchema parameters:** none
- **RequiredParameters:** `policy_domain`
- **OptionalParameters:** `amount`, `currency`, `quantity`
- **AllowedRoles:** `admin`, `employee`, `finance_editor`, `Platform Admin`, `procurement_officer`, `Workflow Builder`
- **RiskLevel:** low
- **IsReadOnly:** true
- **SideEffects:** none
- **PromptUsageGuidance:** 

### procurement

#### `procurement.create_purchase_order`

- **DisplayName:** Create Purchase Order
- **Description:** Creates a purchase order for a vendor, item, and quantity.
- **BusinessCapability:** Purchase order creation
- **InputSchema parameters:** none
- **RequiredParameters:** `item_id`, `quantity`, `vendor_id`
- **OptionalParameters:** `business_justification`, `currency`, `unit_price`
- **AllowedRoles:** `admin`, `Platform Admin`, `procurement_manager`, `procurement_officer`, `Workflow Builder`
- **RiskLevel:** high
- **IsReadOnly:** false
- **SideEffects:** `Creates a purchase order.`
- **PromptUsageGuidance:** 

#### `procurement.validate_vendor`

- **DisplayName:** Validate Vendor
- **Description:** Validates that a vendor exists and is active before procurement execution.
- **BusinessCapability:** Vendor validation
- **InputSchema parameters:** none
- **RequiredParameters:** `vendor_id`
- **OptionalParameters:** none
- **AllowedRoles:** `admin`, `Platform Admin`, `procurement_manager`, `procurement_officer`, `Workflow Builder`
- **RiskLevel:** low
- **IsReadOnly:** true
- **SideEffects:** none
- **PromptUsageGuidance:** 


## 3. POLICY CONSTRAINTS

### `demo.echo`

- `demo.echo` — amount greater than 100 requires block (rule `DEMO-AMOUNT-001`, severity high). Keep demo.echo amount at or below 100.

### `finance.clear_invoice`

- `finance.clear_invoice` — user_role equal to "employee" is subject to block (rule `FIN-RBAC-001`, severity critical). Do not generate finance.clear_invoice for employee role.

### `global`

- `global` — is_read_only equal to false requires write_audit_log (rule `GLOBAL-AUDIT-001`, severity high). Add audit.write_audit_log for write, high-risk, or critical workflows.
- `global` — parameters must not contain ["password","token","api_key","secret","authorization","auth_header","private_key"] (rule `GLOBAL-SAFETY-002`, severity critical). Do not include API keys, tokens, passwords, auth headers, private keys, or secrets.
- `global` — risk_level must trigger require_human_approval when it is greater than or equal to "high" (rule `GLOBAL-SAFETY-003`, severity high). Include approval.request_human_approval for high-risk or critical workflows.
- `global` — status not equal to "active_mcp_schema_present" requires require_schema_generation (rule `CAP-GAP-001`, severity high). If a tool is not active, use capability.create_capability_request instead of executing it.
- `global` — step.action must reference a registered tool (rule `GLOBAL-SAFETY-001`, severity critical). Use only tools listed in AVAILABLE TOOLS. Do not invent actions.

### `procurement.create_purchase_order`

- `procurement.create_purchase_order` — quantity greater than 100 requires require_human_approval (rule `PROC-THRESH-001`, severity high). If purchase quantity is above 100, include approval.request_human_approval.
- `procurement.create_purchase_order` — required_parameters must contain ["vendor_id","item_id","quantity"] (rule `PROC-PARAM-001`, severity high). Include vendor_id, item_id, and quantity when using procurement.create_purchase_order.


## 4. PROCESS CONSTRAINTS

- `finance.record_invoice_receipt` — workflow.steps must preserve this order: ["finance.record_invoice_receipt","finance.clear_invoice"] (rule `FIN-PROC-002`, severity critical). Place finance.record_invoice_receipt before finance.clear_invoice.
- `inventory.record_goods_receipt` — workflow.steps must preserve this order: ["inventory.record_goods_receipt","finance.clear_invoice"] (rule `FIN-PROC-001`, severity critical). Place inventory.record_goods_receipt before finance.clear_invoice.
- `procurement.create_purchase_order` — workflow.steps must preserve this order: ["procurement.validate_vendor","procurement.create_purchase_order"] (rule `PROC-POLICY-001`, severity high). Run procurement.validate_vendor before creating a purchase order.

## 5. SENSITIVE FIELDS

The deterministic validator scans parameter keys for these case-insensitive field-name fragments:

- `api_key`
- `apikey`
- `auth_header`
- `authorization`
- `password`
- `private_key`
- `secret`
- `token`
