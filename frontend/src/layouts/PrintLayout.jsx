/*******************************************************************************
 * Function: PrintLayout
 *
 * Performs the Print Layout operation on layout for the PrintLayout module.
 ******************************************************************************/
function PrintLayout({ children }) {
  return (
    <article className="mx-auto max-w-5xl bg-white p-10 text-gray-950">{children}</article>
  );
}

export default PrintLayout;
