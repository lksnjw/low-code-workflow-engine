/*******************************************************************************
 * Function: Textarea
 *
 * Performs the Textarea operation on the application for the Textarea module.
 ******************************************************************************/
function Textarea({ className = "", ...props }) {
  return (
    <textarea
      className={`min-h-32 w-full resize-none rounded-2xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-primary focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackgroundVery dark:text-gray-100 ${className}`}
      {...props}
    />
  );
}

export default Textarea;
