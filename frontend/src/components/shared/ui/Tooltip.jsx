/*******************************************************************************
 * Function: Tooltip
 *
 * Performs the Tooltip operation on the application for the Tooltip module.
 ******************************************************************************/
function Tooltip({ label, children }) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden -translate-x-1/2 rounded-lg bg-gray-950 px-2 py-1 text-xs font-semibold text-white shadow-xl group-hover:block">
        {label}
      </span>
    </span>
  );
}

export default Tooltip;
