import { Icon } from "@iconify/react";
import { NAVIGATION_GROUPS, filterNavigationGroups } from "../../constants/navigation";
import { useRoute } from "../../context/RouteContext";
import usePermissions from "../../hooks/usePermissions";

function Sidebar({ isCollapsed, onToggle }) {
  const { activeMain, activeSub, navigateTo, setActiveSub } = useRoute();
  const { hasAny, roleId } = usePermissions();
  const visibleGroups = filterNavigationGroups(NAVIGATION_GROUPS, hasAny, roleId);
  const activeGroup = visibleGroups.find((group) => group.id === activeMain) ?? visibleGroups[0];

  return (
    <aside className="hidden h-screen shrink-0 md:flex">
      <div className="relative z-[100] flex w-16 flex-col border-r border-gray-200 bg-white dark:border-darkBackgroundVery dark:bg-darkBackground">
        <div className="flex shrink-0 items-center justify-center p-4">
          <button
            type="button"
            onClick={onToggle}
            className={`flex h-8 w-8 items-center justify-center text-gray-400 transition-all duration-200 hover:text-primary ${
              isCollapsed ? "rotate-0" : "rotate-180"
            }`}
            aria-label="Toggle sidebar"
          >
            <Icon icon="mdi:chevron-left" className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 scrollbar-hide">
          {visibleGroups.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => navigateTo(item.id, item.subMenu[0]?.id)}
              className={`group relative flex h-12 w-12 items-center justify-center rounded-lg transition-colors ${
                activeMain === item.id
                  ? "text-primary"
                  : "text-gray-400 hover:bg-gray-50 hover:text-gray-700 dark:text-gray-500 dark:hover:bg-black dark:hover:text-gray-300"
              }`}
              aria-label={item.label}
            >
              <Icon icon={item.icon} className="h-6 w-6" />
              <span className="pointer-events-none fixed left-[76px] z-[10000] hidden min-w-[210px] rounded-lg border border-gray-200 bg-white/80 px-4 py-3 text-left shadow-2xl backdrop-blur-md group-hover:block dark:border-gray-800 dark:bg-darkBackgroundVery/80">
                <span className="block text-sm font-semibold text-gray-900 dark:text-white">
                  {item.label}
                </span>
                <span className="mt-1 block text-xs leading-5 text-gray-600 dark:text-gray-300">
                  {item.description}
                </span>
              </span>
            </button>
          ))}
        </nav>
      </div>

      <div
        className={`relative z-[50] overflow-hidden border-r border-gray-200 bg-backgroundLight transition-all duration-300 dark:border-darkBackgroundVery dark:bg-darkBackground ${
          isCollapsed ? "w-0" : "w-64"
        }`}
      >
        {!isCollapsed && activeGroup && (
          <div className="flex h-full w-64 flex-col">
            <div className="border-b border-gray-200 p-4 dark:border-darkBackgroundVery">
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {activeGroup.label}
              </h2>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {activeGroup.description}
              </p>
            </div>

            <div className="p-4">
              <label className="relative block">
                <Icon
                  icon="mdi:magnify"
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
                />
                <input
                  type="search"
                  placeholder={`Search ${activeGroup.label.toLowerCase()}...`}
                  className="w-full rounded-full border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 outline-none transition focus:border-primary focus:ring-1 focus:ring-primary dark:border-darkBackgroundVery dark:bg-darkBackgroundVery dark:text-gray-100"
                />
              </label>
            </div>

            <nav className="flex-1 space-y-1 px-4 pb-4">
              {activeGroup.subMenu.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveSub(item.id)}
                  className={`flex w-full items-center justify-between rounded-full px-3 py-2 text-sm transition-colors ${
                    activeSub === item.id
                      ? "bg-white font-semibold text-primary dark:bg-darkBackgroundVery"
                      : "text-gray-600 hover:bg-gray-100 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-black dark:hover:text-white"
                  }`}
                >
                  <span>{item.label}</span>
                  {item.hasNotification && (
                    <span className="h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
                  )}
                </button>
              ))}
            </nav>
          </div>
        )}
      </div>
    </aside>
  );
}

export default Sidebar;
