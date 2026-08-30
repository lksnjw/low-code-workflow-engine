/*******************************************************************************
 * Function: formatPercent
 *
 * Formats percent for the number utils module.
 ******************************************************************************/
export function formatPercent(value) {
  return `${Number(value).toFixed(1)}%`;
}

/*******************************************************************************
 * Function: formatCurrency
 *
 * Formats currency for the number utils module.
 ******************************************************************************/
export function formatCurrency(value) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format(value);
}
