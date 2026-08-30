/*******************************************************************************
 * Function: CanvasMinimap
 *
 * Performs the Canvas Minimap operation on minimap for the CanvasMinimap module.
 ******************************************************************************/
function CanvasMinimap() {
  return (
    <div className="absolute bottom-4 right-4 h-28 w-40 rounded-xl border border-gray-200 bg-white/85 p-2 shadow-soft backdrop-blur dark:border-gray-800 dark:bg-darkBackground/85">
      <div className="h-full rounded-lg bg-primary/10" />
    </div>
  );
}

export default CanvasMinimap;
