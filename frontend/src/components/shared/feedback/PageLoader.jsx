import Spinner from "../ui/Spinner";

/*******************************************************************************
 * Function: PageLoader
 *
 * Performs the Page Loader operation on loader for the PageLoader module.
 ******************************************************************************/
function PageLoader() {
  return (
    <div className="flex min-h-96 items-center justify-center">
      <Spinner className="text-primary" />
    </div>
  );
}

export default PageLoader;
