/*******************************************************************************
 * Function: Dropdown
 *
 * Performs the Dropdown operation on the application for the Dropdown module.
 ******************************************************************************/
function Dropdown({ options = [] }) {
  return (
    <select className="rounded-full border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-darkBackgroundVery">
      {options.map((option) => (
        <option key={option.value ?? option} value={option.value ?? option}>
          {option.label ?? option}
        </option>
      ))}
    </select>
  );
}

export default Dropdown;
