/*******************************************************************************
 * Function: readStorage
 *
 * Reads storage for the storage utils module.
 ******************************************************************************/
export function readStorage(key, fallback = null) {
  const value = localStorage.getItem(key);
  return value ? JSON.parse(value) : fallback;
}

/*******************************************************************************
 * Function: writeStorage
 *
 * Writes storage for the storage utils module.
 ******************************************************************************/
export function writeStorage(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
