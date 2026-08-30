/*******************************************************************************
 * Function: Alert
 *
 * Performs the Alert operation on the application for the Alert module.
 ******************************************************************************/
function Alert({ children, tone = "info" }) {
  const toneClass =
    tone === "danger"
      ? "border-red-200 bg-red-50 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300"
      : "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300";

  return <div className={`rounded-xl border px-4 py-3 text-sm ${toneClass}`}>{children}</div>;
}

export default Alert;
