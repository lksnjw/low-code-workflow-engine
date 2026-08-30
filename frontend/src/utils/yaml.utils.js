/*******************************************************************************
 * Function: stringifyWorkflow
 *
 * Serializes workflow for the yaml utils module.
 ******************************************************************************/
export function stringifyWorkflow(workflow) {
  return Object.entries(workflow)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
}

/*******************************************************************************
 * Function: validateYamlText
 *
 * Validates yaml text for the yaml utils module.
 ******************************************************************************/
export function validateYamlText(text) {
  return {
    valid: Boolean(text?.trim()),
    errors: text?.trim() ? [] : ["YAML content is required."],
  };
}
