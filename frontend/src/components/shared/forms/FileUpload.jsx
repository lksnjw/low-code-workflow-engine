/*******************************************************************************
 * Function: FileUpload
 *
 * Performs the File Upload operation on upload for the FileUpload module.
 ******************************************************************************/
function FileUpload() {
  return (
    <label className="flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-800">
      Drop YAML or JSON here
      <input type="file" className="sr-only" />
    </label>
  );
}

export default FileUpload;
