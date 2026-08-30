/*******************************************************************************
 * Function: sumBy
 *
 * Performs the sum By operation on by for the analytics utils module.
 ******************************************************************************/
export function sumBy(items, key) {
  return items.reduce((total, item) => total + Number(item[key] ?? 0), 0);
}
