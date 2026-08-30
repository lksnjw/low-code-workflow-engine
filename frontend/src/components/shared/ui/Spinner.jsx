/*******************************************************************************
 * Function: Spinner
 *
 * Performs the Spinner operation on the application for the Spinner module.
 ******************************************************************************/
function Spinner({ className = "" }) {
  return (
    <span
      className={`inline-block h-5 w-5 animate-spin rounded-full border-2 border-current border-r-transparent ${className}`}
      aria-label="Loading"
    />
  );
}

export default Spinner;
