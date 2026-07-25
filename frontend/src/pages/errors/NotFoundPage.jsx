import EmptyState from "../../components/shared/ui/EmptyState";

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
