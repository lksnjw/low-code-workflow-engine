/*******************************************************************************
 * Function: Toggle
 *
 * Performs the Toggle operation on the application for the Toggle module.
 ******************************************************************************/
function Toggle({ checked, onChange, label, ariaLabel, describedBy, disabled = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-full px-1 text-gray-700 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60 dark:text-gray-200 dark:focus-visible:ring-offset-darkBackground"
    >
      <span aria-hidden="true" className={`flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors ${checked ? "bg-primary" : "bg-gray-300 dark:bg-gray-600"}`}>
        <span className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none ${checked ? "translate-x-5" : "translate-x-0"}`} />
      </span>
      {label && <span className="min-w-6 text-sm font-semibold">{label}</span>}
    </button>
  );
}

export default Toggle;
