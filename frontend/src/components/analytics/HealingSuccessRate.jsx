import Card from "../shared/ui/Card";
import Progress from "../shared/ui/Progress";

/*******************************************************************************
 * Function: HealingSuccessRate
 *
 * Performs the Healing Success Rate operation on success rate for the HealingSuccessRate module.
 ******************************************************************************/
function HealingSuccessRate({ data = {} }) {
  const rate = Number(data.successRate || 0);
  return <Card><h2 className="section-title">Healing Success</h2><p className="mt-4 text-4xl font-bold text-gray-950 dark:text-white">{rate.toFixed(1)}%</p><div className="mt-4"><Progress value={rate} /></div><p className="mt-3 text-sm text-gray-500 dark:text-gray-400">{data.recovered || 0} of {data.attempts || 0} recorded repair attempts succeeded.</p></Card>;
}

export default HealingSuccessRate;
