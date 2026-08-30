/*******************************************************************************
 * Function: Tag
 *
 * Performs the Tag operation on the application for the Tag module.
 ******************************************************************************/
function Tag({ children }) {
  return (
    <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-600 dark:bg-darkBackgroundVery dark:text-gray-300">
      {children}
    </span>
  );
}

export default Tag;
