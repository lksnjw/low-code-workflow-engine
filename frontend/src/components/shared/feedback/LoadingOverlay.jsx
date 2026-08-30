import Spinner from "../ui/Spinner";

/*******************************************************************************
 * Function: LoadingOverlay
 *
 * Performs the Loading Overlay operation on overlay for the LoadingOverlay module.
 ******************************************************************************/
function LoadingOverlay() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-white/70 dark:bg-black/60">
      <Spinner className="text-primary" />
    </div>
  );
}

export default LoadingOverlay;
