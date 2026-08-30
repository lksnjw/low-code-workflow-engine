import { Icon } from "@iconify/react";
import Card from "../shared/ui/Card";

const toneClasses = {
  primary: "bg-primary/10 text-primary",
  green: "bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  purple:
    "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-500/15 dark:text-fuchsia-300",
};

/*******************************************************************************
 * Function: StatsCard
 *
 * Performs the Stats Card operation on card for the StatsCard module.
 ******************************************************************************/
function StatsCard({ metric }) {
  return (
    <Card className="min-h-[142px]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-gray-500 dark:text-gray-400">
            {metric.label}
          </p>
          <p className="metric-number mt-4 text-gray-950 dark:text-white">{metric.value}</p>
        </div>
        <span
          className={`hidden h-11 w-11 items-center justify-center rounded-full sm:flex ${
            toneClasses[metric.tone]
          }`}
        >
          <Icon icon={metric.icon} className="h-5 w-5" />
        </span>
      </div>
      <p className="mt-4 text-sm font-semibold text-green-600 dark:text-green-300">
        {metric.delta}
        <span className="ml-1 font-normal text-gray-500 dark:text-gray-400">from last week</span>
      </p>
    </Card>
  );
}

export default StatsCard;
