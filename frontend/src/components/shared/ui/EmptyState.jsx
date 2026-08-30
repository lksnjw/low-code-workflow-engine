import { Icon } from "@iconify/react";

/*******************************************************************************
 * Function: EmptyState
 *
 * Performs the Empty State operation on state for the EmptyState module.
 ******************************************************************************/
function EmptyState({ icon = "mdi:database-off-outline", title, description }) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center rounded-2xl border border-dashed border-gray-300 p-8 text-center dark:border-gray-800">
      <Icon icon={icon} className="h-9 w-9 text-gray-400" />
      <h3 className="mt-3 text-base font-semibold text-gray-900 dark:text-white">{title}</h3>
      {description && (
        <p className="mt-2 max-w-md text-sm text-gray-500 dark:text-gray-400">
          {description}
        </p>
      )}
    </div>
  );
}

export default EmptyState;
