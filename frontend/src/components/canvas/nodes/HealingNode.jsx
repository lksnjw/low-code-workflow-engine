import TriggerNode from "./TriggerNode";

/*******************************************************************************
 * Function: HealingNode
 *
 * Performs the Healing Node operation on node for the HealingNode module.
 ******************************************************************************/
function HealingNode(props) {
  return <TriggerNode label="Self-Healing" {...props} />;
}

export default HealingNode;
