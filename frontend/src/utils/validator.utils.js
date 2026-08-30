/*******************************************************************************
 * Function: required
 *
 * Performs the required operation on the application for the validator utils module.
 ******************************************************************************/
export function required(value) {
  return value ? null : "This field is required.";
}

/*******************************************************************************
 * Function: isUrl
 *
 * Determines whether url for the validator utils module.
 ******************************************************************************/
export function isUrl(value) {
  try {
    new URL(value);
    return null;
  } catch {
    return "Enter a valid URL.";
  }
}
