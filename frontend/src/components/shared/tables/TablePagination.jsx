import Button from "../ui/Button";

/*******************************************************************************
 * Function: TablePagination
 *
 * Performs the Table Pagination operation on pagination for the TablePagination module.
 ******************************************************************************/
function TablePagination({ page = 1, pageCount = 1, onPageChange }) {
  return (
    <div className="flex items-center justify-end gap-2">
      <Button variant="secondary" onClick={() => onPageChange?.(Math.max(1, page - 1))}>
        Previous
      </Button>
      <span className="text-sm font-semibold text-gray-500">
        {page} / {pageCount}
      </span>
      <Button variant="secondary" onClick={() => onPageChange?.(Math.min(pageCount, page + 1))}>
        Next
      </Button>
    </div>
  );
}

export default TablePagination;
