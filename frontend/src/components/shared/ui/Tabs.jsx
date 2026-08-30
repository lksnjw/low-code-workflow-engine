/*******************************************************************************
 * Function: Tabs
 *
 * Performs the Tabs operation on the application for the Tabs module.
 ******************************************************************************/
function Tabs({ tabs = [], active = tabs[0]?.id, onChange }) {
  return (
    <div className="flex gap-2 overflow-x-auto scrollbar-hide">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange?.(tab.id)}
          className={`rounded-full px-3 py-2 text-sm font-semibold ${
            active === tab.id
              ? "bg-primary text-white"
              : "bg-gray-100 text-gray-600 dark:bg-darkBackgroundVery dark:text-gray-300"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export default Tabs;
