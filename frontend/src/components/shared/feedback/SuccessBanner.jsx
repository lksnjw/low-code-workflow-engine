/*******************************************************************************
 * Function: SuccessBanner
 *
 * Performs the Success Banner operation on banner for the SuccessBanner module.
 ******************************************************************************/
function SuccessBanner({ children }) {
  return (
    <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-semibold text-green-700 dark:border-green-500/20 dark:bg-green-500/10 dark:text-green-300">
      {children}
    </div>
  );
}

export default SuccessBanner;
