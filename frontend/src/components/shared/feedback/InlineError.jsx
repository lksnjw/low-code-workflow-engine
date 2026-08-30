/*******************************************************************************
 * Function: InlineError
 *
 * Performs the Inline Error operation on error for the InlineError module.
 ******************************************************************************/
function InlineError({ children }) {
  return <p className="text-sm font-semibold text-red-500">{children}</p>;
}

export default InlineError;
