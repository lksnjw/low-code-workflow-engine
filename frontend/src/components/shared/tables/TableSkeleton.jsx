import Skeleton from "../ui/Skeleton";

/*******************************************************************************
 * Function: TableSkeleton
 *
 * Performs the Table Skeleton operation on skeleton for the TableSkeleton module.
 ******************************************************************************/
function TableSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

export default TableSkeleton;
