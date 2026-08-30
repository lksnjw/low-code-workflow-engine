/*******************************************************************************
 * Function: CanvasContextMenu
 *
 * Performs the Canvas Context Menu operation on context menu for the CanvasContextMenu module.
 ******************************************************************************/
function CanvasContextMenu({ x = 0, y = 0, open = false }) {
  if (!open) return null;

  return (
    <div
      className="absolute z-40 rounded-xl border border-gray-200 bg-white p-2 text-sm shadow-panel dark:border-gray-800 dark:bg-darkBackground"
      style={{ left: x, top: y }}
    >
      {["Add action", "Add condition", "Add note"].map((item) => (
        <button key={item} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-black">
          {item}
        </button>
      ))}
    </div>
  );
}

export default CanvasContextMenu;
