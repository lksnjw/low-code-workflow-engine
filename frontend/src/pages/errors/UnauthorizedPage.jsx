import EmptyState from "../../components/shared/ui/EmptyState";

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
