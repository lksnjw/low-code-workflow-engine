import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import TemplateCard from "../../components/workflows/TemplateCard";
import { EmptyState, ErrorState, LoadingState } from "../../components/shared/ResourceState";
import { workflowService } from "../../services/workflow.service";
import { useNotifications } from "../../context/NotificationContext";
import { apiErrorMessage } from "../../services/api";
import { useRoute } from "../../context/RouteContext";

/*******************************************************************************
 * Function: WorkflowTemplatePage
 *
 * Performs the Workflow Template Page operation on template page for the WorkflowTemplatePage module.
 ******************************************************************************/
function WorkflowTemplatePage() {
  const { data: templates = [], isLoading, error, refetch } = useQuery({ queryKey: ["workflow-templates"], queryFn: workflowService.listTemplates });
  const [busyId, setBusyId] = useState(null);
  const { notify } = useNotifications();
  const { openWorkflow } = useRoute();
/*******************************************************************************
 * Function: handleUseTemplate
 *
 * Handles use template for the WorkflowTemplatePage module.
 ******************************************************************************/
  const handleUseTemplate = async (template) => {
    setBusyId(template.id);
    try { const workflow = await workflowService.useTemplate(template.id, template.name); notify("Workflow created from template.", "success"); openWorkflow(workflow.id); }
    catch (useError) { notify(apiErrorMessage(useError, "Could not use template."), "error"); }
    finally { setBusyId(null); }
  };
  if (isLoading) return <LoadingState label="Loading templates…" />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  return <div className="space-y-6"><div><h1 className="page-heading text-gray-950 dark:text-white">Template Gallery</h1><p className="mt-3 text-sm text-gray-500 dark:text-gray-400">Templates created in this installation.</p></div>{templates.length === 0 ? <EmptyState title="No templates yet" description="Save a validated workflow as a template to populate this gallery." /> : <div className="grid gap-4 lg:grid-cols-3">{templates.map((template) => <TemplateCard key={template.id} title={template.name} description={template.description} steps={template.steps} busy={busyId === template.id} onUse={() => handleUseTemplate(template)} />)}</div>}</div>;
}

export default WorkflowTemplatePage;
