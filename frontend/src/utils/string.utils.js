/*******************************************************************************
 * Function: truncate
 *
 * Performs the truncate operation on the application for the string utils module.
 ******************************************************************************/
export function truncate(value, length = 80) {
  if (!value || value.length <= length) return value;
  return `${value.slice(0, length - 1)}...`;
}

/*******************************************************************************
 * Function: slugify
 *
 * Performs the slugify operation on the application for the string utils module.
 ******************************************************************************/
export function slugify(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
