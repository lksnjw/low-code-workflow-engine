import { Icon } from "@iconify/react";
import Card from "../../shared/ui/Card";

/*******************************************************************************
 * Function: ValidationPanel
 *
 * Performs the Validation Panel operation on panel for the ValidationPanel module.
 ******************************************************************************/
function ValidationPanel() {
  const checks = ["Schema valid", "RBAC policy attached", "Retry budget configured"];

  return (
    <Card>
      <h2 className="section-title">Validation</h2>
      <div className="mt-4 space-y-3">
        {checks.map((check) => (
          <div key={check} className="flex items-center gap-3 text-sm font-semibold">
            <Icon icon="mdi:check-circle" className="h-5 w-5 text-green-500" />
            <span className="text-gray-700 dark:text-gray-200">{check}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default ValidationPanel;
