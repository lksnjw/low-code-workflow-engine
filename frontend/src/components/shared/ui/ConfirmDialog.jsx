import Button from "./Button";
import Modal from "./Modal";

/*******************************************************************************
 * Function: ConfirmDialog
 *
 * Performs the Confirm Dialog operation on dialog for the ConfirmDialog module.
 ******************************************************************************/
function ConfirmDialog({ open, title = "Confirm action", onConfirm, children }) {
  return (
    <Modal open={open} title={title}>
      <div className="space-y-4">
        <div className="text-sm text-gray-600 dark:text-gray-300">{children}</div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary">Cancel</Button>
          <Button onClick={onConfirm}>Confirm</Button>
        </div>
      </div>
    </Modal>
  );
}

export default ConfirmDialog;
