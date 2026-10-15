/*******************************************************************************
 * Function: DataTable
 *
 * Performs the Data Table operation on table for the DataTable module.
 ******************************************************************************/
function DataTable({ columns, rows, renderCell, label = "Data table" }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-800">
      <div role="region" aria-label={label} tabIndex={0} className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
      <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-800">
        <thead className="bg-backgroundLight dark:bg-darkBackgroundVery">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className="px-4 py-3 text-left text-xs font-bold uppercase tracking-normal text-gray-500 dark:text-gray-400"
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-800 dark:bg-darkBackground">
          {rows.map((row) => (
            <tr key={row.id ?? row.name} className="hover:bg-gray-50 dark:hover:bg-black/30">
              {columns.map((column) => (
                <td key={column.key} className="px-4 py-3 text-gray-700 dark:text-gray-200">
                  {renderCell ? renderCell(row, column) : row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

export default DataTable;
