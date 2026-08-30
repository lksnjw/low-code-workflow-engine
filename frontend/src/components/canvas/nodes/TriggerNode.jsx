import { Icon } from "@iconify/react";

/*******************************************************************************
 * Function: TriggerNode
 *
 * Performs the Trigger Node operation on node for the TriggerNode module.
 ******************************************************************************/
function TriggerNode({ label = "Trigger" }) {
  return (
    <div className="workflow-node p-4">
      <Icon icon="mdi:flash-outline" className="h-5 w-5 text-primary" />
      <p className="mt-2 text-sm font-bold">{label}</p>
    </div>
  );
}

export default TriggerNode;
