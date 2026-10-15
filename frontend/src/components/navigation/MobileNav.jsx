import { NAVIGATION_GROUPS, filterNavigationGroups } from "../../constants/navigation";
import { useRoute } from "../../context/RouteContext";
import usePermissions from "../../hooks/usePermissions";

/*******************************************************************************
 * Function: MobileNav
 *
 * Performs the Mobile Nav operation on nav for the MobileNav module.
 ******************************************************************************/
function MobileNav() {
  const { activeMain, activeSub, navigateTo } = useRoute();
  const { hasAny, roleId } = usePermissions();
  const visibleGroups = filterNavigationGroups(NAVIGATION_GROUPS, hasAny, roleId);
  const activeGroup = visibleGroups.find(group => group.id === activeMain);

  return (
    <div className="border-b border-gray-200 bg-backgroundLight px-4 py-3 dark:border-darkBackgroundVery dark:bg-darkBackground md:hidden">
      <nav aria-label="Mobile main navigation" className="flex gap-2 overflow-x-auto pb-1">
        {visibleGroups.map((group) => (
          <button
            key={group.id}
            type="button"
            aria-pressed={activeMain === group.id}
            onClick={() => navigateTo(group.id, group.subMenu[0]?.id)}
            className={`shrink-0 rounded-full px-3 py-2 text-sm font-semibold ${
              activeMain === group.id
                ? "bg-primary text-white"
                : "bg-white text-gray-600 dark:bg-darkBackgroundVery dark:text-gray-300"
            }`}
          >
            {group.label}
          </button>
        ))}
      </nav>
      {activeGroup && activeGroup.subMenu.length > 1 && <nav aria-label={`${activeGroup.label} pages`} className="mt-2 flex gap-2 overflow-x-auto pb-1">
        {activeGroup.subMenu.filter(item => !item.path.includes(":" ) || item.id === activeSub).map(item => <button
          key={item.id}
          type="button"
          aria-current={activeSub === item.id ? "page" : undefined}
          onClick={() => navigateTo(activeGroup.id, item.id)}
          className={`min-h-9 shrink-0 rounded-md px-3 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${activeSub === item.id ? "bg-primary/10 text-primary" : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"}`}
        >{item.label}</button>)}
      </nav>}
    </div>
  );
}

export default MobileNav;
