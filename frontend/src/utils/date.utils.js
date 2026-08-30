/*******************************************************************************
 * Function: formatDateTime
 *
 * Formats date time for the date utils module.
 ******************************************************************************/
export function formatDateTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
