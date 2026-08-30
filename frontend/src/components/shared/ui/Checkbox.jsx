/*******************************************************************************
 * Function: Checkbox
 *
 * Performs the Checkbox operation on the application for the Checkbox module.
 ******************************************************************************/
function Checkbox({ label, ...props }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
      <input type="checkbox" className="h-4 w-4 rounded border-gray-300 text-primary" {...props} />
      {label}
    </label>
  );
}

export default Checkbox;
