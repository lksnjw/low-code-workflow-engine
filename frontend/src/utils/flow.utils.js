/*******************************************************************************
 * Function: workflowToNodes
 *
 * Performs the workflow To Nodes operation on to nodes for the flow utils module.
 ******************************************************************************/
export function workflowToNodes(workflow) {
  return (workflow?.steps ?? []).map((step, index) => ({
    id: step.id ?? `step-${index}`,
    label: step.label ?? step.id,
    x: index * 220,
    y: 80,
  }));
}

/*******************************************************************************
 * Function: nodesToWorkflow
 *
 * Performs the nodes To Workflow operation on to workflow for the flow utils module.
 ******************************************************************************/
export function nodesToWorkflow(nodes) {
  return { steps: nodes.map((node) => ({ id: node.id, label: node.label })) };
}
