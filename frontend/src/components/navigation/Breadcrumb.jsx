import { getNavigationGroup } from "../../constants/navigation";
import { useRoute } from "../../context/RouteContext";

/*******************************************************************************
 * Function: Breadcrumb
 *
 * Performs the Breadcrumb operation on the application for the Breadcrumb module.
 ******************************************************************************/
function Breadcrumb() {
  const { activeMain, activeSub } = useRoute();
  const group = getNavigationGroup(activeMain);
/*******************************************************************************
 * Function: sub
 *
 * Performs the sub operation on the application for the Breadcrumb module.
 ******************************************************************************/
  const sub = group.subMenu.find((item) => item.id === activeSub);

  return (
    <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">
      {group.label} / {sub?.label ?? "Overview"}
    </p>
  );
}

export default Breadcrumb;
