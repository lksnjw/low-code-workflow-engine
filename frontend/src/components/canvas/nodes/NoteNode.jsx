/*******************************************************************************
 * Function: NoteNode
 *
 * Performs the Note Node operation on node for the NoteNode module.
 ******************************************************************************/
function NoteNode({ text = "Note" }) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-800">
      {text}
    </div>
  );
}

export default NoteNode;
