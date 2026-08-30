/*******************************************************************************
 * Function: Skeleton
 *
 * Performs the Skeleton operation on the application for the Skeleton module.
 ******************************************************************************/
function Skeleton({ className = "h-4 w-full" }) {
  return <span className={`block animate-pulse rounded-full bg-gray-200 dark:bg-gray-800 ${className}`} />;
}

export default Skeleton;
