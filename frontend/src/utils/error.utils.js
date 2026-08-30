/*******************************************************************************
 * Function: formatApiError
 *
 * Formats api error for the error utils module.
 ******************************************************************************/
export function formatApiError(error) {
  return error?.response?.data?.message ?? error?.message ?? "Unexpected error";
}
