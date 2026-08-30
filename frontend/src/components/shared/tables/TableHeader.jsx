/*******************************************************************************
 * Function: TableHeader
 *
 * Performs the Table Header operation on header for the TableHeader module.
 ******************************************************************************/
function TableHeader({ title, action }) {
  return (
    <div className="mb-4 flex items-center justify-between">
      <h2 className="section-title">{title}</h2>
      {action}
    </div>
  );
}

export default TableHeader;
