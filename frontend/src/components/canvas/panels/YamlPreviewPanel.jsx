import Card from "../../shared/ui/Card";
import CodeBlock from "../../shared/ui/CodeBlock";

const yaml = `name: ERP Invoice Exception Resolver
trigger:
  type: erp.invoice.created
steps:
  - id: classify_intent
    agent: invoice-classifier
  - id: policy_guardrail
    type: condition
  - id: self_heal_retry
    when: connector_error
  - id: notify_finance
    channel: approval_queue`;

/*******************************************************************************
 * Function: YamlPreviewPanel
 *
 * Performs the Yaml Preview Panel operation on preview panel for the YamlPreviewPanel module.
 ******************************************************************************/
function YamlPreviewPanel() {
  return (
    <Card>
      <h2 className="section-title">YAML Preview</h2>
      <p className="section-subtitle mt-1">Generated blueprint from the current canvas.</p>
      <div className="mt-5">
        <CodeBlock code={yaml} />
      </div>
    </Card>
  );
}

export default YamlPreviewPanel;
