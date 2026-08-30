import { Icon } from "@iconify/react";
import { useAuthContext } from "../../context/AuthContext";

/**
 * Shown when the API stops responding. A transport failure is not an expiry:
 * the session is kept, the user stays on the screen they were on, and Retry
 * restores it once the server is back.
 */
/*******************************************************************************
 * Function: ServerUnreachableBanner
 *
 * Performs the Server Unreachable Banner operation on unreachable banner for the ServerUnreachableBanner module.
 ******************************************************************************/
function ServerUnreachableBanner() {
  const { serverUnreachable, retryConnection } = useAuthContext();
  if (!serverUnreachable) return null;

  return (
    <div
      data-testid="server-unreachable-banner"
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2.5 dark:border-amber-500/30 dark:bg-amber-500/10 sm:px-6"
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
        <Icon icon="mdi:cloud-off-outline" className="h-5 w-5" />
        The server is unreachable. Your session is still signed in.
      </p>
      <button
        type="button"
        onClick={retryConnection}
        className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-amber-700"
      >
        Retry
      </button>
    </div>
  );
}

export default ServerUnreachableBanner;
