/*******************************************************************************
 * Function: FormField
 *
 * Performs the Form Field operation on field for the FormField module.
 ******************************************************************************/
function FormField({ label, error, children }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-200">
        {label}
      </span>
      {children}
      {error && <span className="mt-1 block text-xs text-red-500">{error}</span>}
    </label>
  );
}

export default FormField;
