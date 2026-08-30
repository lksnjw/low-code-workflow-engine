/*******************************************************************************
 * Function: Drawer
 *
 * Performs the Drawer operation on the application for the Drawer module.
 ******************************************************************************/
function Drawer({ children, open = false }) {
  return (
    <aside
      className={`fixed right-0 top-0 z-[998] h-full w-full max-w-md border-l border-gray-200 bg-white p-6 shadow-panel transition-transform dark:border-gray-800 dark:bg-darkBackground ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
    >
      {children}
    </aside>
  );
}

export default Drawer;
