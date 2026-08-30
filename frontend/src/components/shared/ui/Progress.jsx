/*******************************************************************************
 * Function: Progress
 *
 * Performs the Progress operation on the application for the Progress module.
 ******************************************************************************/
function Progress({ value = 0, className = "" }) {
  return (
    <div className={`h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-black ${className}`}>
      <div
        className="h-full rounded-full bg-primary transition-all"
        style={{ width: `${Math.min(Math.max(value, 0), 100)}%` }}
      />
    </div>
  );
}

export default Progress;
