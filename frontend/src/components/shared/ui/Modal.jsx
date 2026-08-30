/*******************************************************************************
 * Function: Modal
 *
 * Performs the Modal operation on the application for the Modal module.
 ******************************************************************************/
function Modal({ title, children, open = false }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/50 p-4">
      <section className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-panel dark:bg-darkBackground">
        {title && <h2 className="text-lg font-bold text-gray-950 dark:text-white">{title}</h2>}
        <div className="mt-4">{children}</div>
      </section>
    </div>
  );
}

export default Modal;
