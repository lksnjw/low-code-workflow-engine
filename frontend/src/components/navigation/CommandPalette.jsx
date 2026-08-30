import { Icon } from "@iconify/react";
import { NAVIGATION_GROUPS, filterNavigationGroups } from "../../constants/navigation";
import { useRoute } from "../../context/RouteContext";
import usePermissions from "../../hooks/usePermissions";

/*******************************************************************************
 * Function: CommandPalette
 *
 * Performs the Command Palette operation on palette for the CommandPalette module.
 ******************************************************************************/
function CommandPalette() {
  const { navigateTo } = useRoute();
  const { hasAny, roleId } = usePermissions();
  // Quick targets are navigation, so they obey exactly the same permission
  // filter as the sidebar. Unfiltered shortcuts sent every role to Access denied.
  const quickTargets = filterNavigationGroups(NAVIGATION_GROUPS, hasAny, roleId).slice(0, 4);

  return (
    <div className="hidden min-w-[360px] max-w-xl flex-1 items-center justify-center lg:flex">
      <div className="flex w-full items-center gap-2 rounded-full border border-gray-200 bg-backgroundLight px-2 py-1 dark:border-darkBackgroundVery dark:bg-darkBackgroundVery">
        <Icon icon="mdi:magnify" className="ml-2 h-4 w-4 text-gray-400" />
        <input
          className="min-w-0 flex-1 bg-transparent px-1 py-2 text-sm text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100"
          placeholder="Command palette, workflow search, run id..."
        />
        <div className="flex gap-1">
          {quickTargets.map((target) => (
            <button
              key={target.id}
              type="button"
              onClick={() => navigateTo(target.id, target.subMenu[0]?.id)}
              className="rounded-full px-2.5 py-1 text-xs font-semibold text-gray-500 transition hover:bg-white hover:text-primary dark:text-gray-400 dark:hover:bg-darkBackground dark:hover:text-white"
            >
              {target.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default CommandPalette;
