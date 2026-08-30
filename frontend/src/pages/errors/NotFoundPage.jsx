import EmptyState from "../../components/shared/ui/EmptyState";

/*******************************************************************************
 * Function: NotFoundPage
 *
 * Performs the Not Found Page operation on found page for the NotFoundPage module.
 ******************************************************************************/
function NotFoundPage() {
  return (
    <EmptyState
      icon="mdi:map-marker-off-outline"
      title="Page not found"
      description="This URL does not match a workflow console route."
    />
  );
}

export default NotFoundPage;
