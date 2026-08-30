/*******************************************************************************
 * Function: Input
 *
 * Performs the Input operation on the application for the Input module.
 ******************************************************************************/
function Input({ className = "", ...props }) {
  return (
    <input
      className={`w-full rounded-full border border-gray-300 bg-white px-4 py-2 text-sm text-gray-900 outline-none transition focus:border-primary focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackgroundVery dark:text-gray-100 ${className}`}
      {...props}
    />
  );
}

export default Input;
