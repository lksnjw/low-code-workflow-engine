import EmptyState from "../../components/shared/ui/EmptyState";

/*******************************************************************************
 * Function: UnauthorizedPage
 *
 * Performs the Unauthorized Page operation on page for the UnauthorizedPage module.
 ******************************************************************************/
function UnauthorizedPage() {
  return (
    <EmptyState
      icon="mdi:lock-alert-outline"
      title="Access denied"
      description="Your role does not include permission to open this workspace."
    />
  );
}

export default UnauthorizedPage;
