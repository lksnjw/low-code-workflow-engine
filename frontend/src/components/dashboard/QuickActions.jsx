import { Icon } from "@iconify/react";
import Card from "../shared/ui/Card";
import Button from "../shared/ui/Button";
import { useRoute } from "../../context/RouteContext";

/*******************************************************************************
 * Function: QuickActions
 *
 * Performs the Quick Actions operation on actions for the QuickActions module.
 ******************************************************************************/
function QuickActions() {
  const { navigateTo, startWorkflow } = useRoute();
  const actions = [
    {
      label: "New Workflow",
      icon: "mdi:plus",
      onClick: startWorkflow,
    },
    {
      label: "Synthesize YAML",
      icon: "hugeicons:ai-magic",
      onClick: () => navigateTo("chat", "session"),
    },
    {
      label: "Watch Logs",
      icon: "mdi:console-line",
      onClick: () => navigateTo("executions", "live"),
    },
  ];

  return (
    <Card>
      <h2 className="section-title">Quick Actions</h2>
      <p className="section-subtitle mt-1">High-frequency workflow operations.</p>
      <div className="mt-5 grid gap-3">
        {actions.map((action, index) => (
          <Button
            key={action.label}
            variant={index === 0 ? "primary" : "secondary"}
            className="justify-start"
            onClick={action.onClick}
          >
            <Icon icon={action.icon} className="h-5 w-5" />
            {action.label}
          </Button>
        ))}
      </div>
    </Card>
  );
}

export default QuickActions;
