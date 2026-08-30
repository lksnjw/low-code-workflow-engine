/*******************************************************************************
 * Function: Toggle
 *
 * Performs the Toggle operation on the application for the Toggle module.
 ******************************************************************************/
function Toggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange?.(!checked)}
      className={`flex items-center gap-3 rounded-full border px-2 py-1 transition ${
        checked
          ? "border-primary bg-primary/10"
          : "border-gray-300 bg-white dark:border-gray-700 dark:bg-darkBackground"
      }`}
    >
      <span
        className={`h-6 w-6 rounded-full transition ${
          checked ? "translate-x-5 bg-primary" : "bg-gray-300 dark:bg-gray-600"
        }`}
      />
      {label && <span className="pr-3 text-sm font-semibold">{label}</span>}
    </button>
  );
}

export default Toggle;
