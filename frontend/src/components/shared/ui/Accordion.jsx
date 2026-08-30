/*******************************************************************************
 * Function: Accordion
 *
 * Performs the Accordion operation on the application for the Accordion module.
 ******************************************************************************/
function Accordion({ title, children }) {
  return (
    <details className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-darkBackground">
      <summary className="cursor-pointer text-sm font-bold text-gray-900 dark:text-white">
        {title}
      </summary>
      <div className="mt-3 text-sm text-gray-600 dark:text-gray-300">{children}</div>
    </details>
  );
}

export default Accordion;
