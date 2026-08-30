/*******************************************************************************
 * Function: Select
 *
 * Performs the Select operation on the application for the Select module.
 ******************************************************************************/
function Select({ children, className = "", ...props }) {
  return (
    <select
      className={`rounded-full border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 outline-none transition focus:border-primary focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackgroundVery dark:text-gray-200 ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}

export default Select;
