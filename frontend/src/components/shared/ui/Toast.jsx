/*******************************************************************************
 * Function: Toast
 *
 * Performs the Toast operation on the application for the Toast module.
 ******************************************************************************/
function Toast({ children }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm shadow-panel dark:border-gray-800 dark:bg-darkBackground">
      {children}
    </div>
  );
}

export default Toast;
