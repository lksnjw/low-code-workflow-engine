/*******************************************************************************
 * Function: initSentry
 *
 * Performs the init Sentry operation on sentry for the sentry module.
 ******************************************************************************/
export function initSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) {
    return false;
  }
  return true;
}
