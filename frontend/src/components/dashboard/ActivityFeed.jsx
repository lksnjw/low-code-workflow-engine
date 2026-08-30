import { Icon } from "@iconify/react";
import Card from "../shared/ui/Card";
import { EmptyState } from "../shared/ResourceState";

const tones = {
  green: "text-green-600 bg-green-50 dark:bg-green-500/10 dark:text-green-300",
  purple:
    "text-fuchsia-600 bg-fuchsia-50 dark:bg-fuchsia-500/10 dark:text-fuchsia-300",
  blue: "text-blue-600 bg-blue-50 dark:bg-blue-500/10 dark:text-blue-300",
  amber: "text-amber-600 bg-amber-50 dark:bg-amber-500/10 dark:text-amber-300",
};

/*******************************************************************************
 * Function: ActivityFeed
 *
 * Performs the Activity Feed operation on feed for the ActivityFeed module.
 ******************************************************************************/
function ActivityFeed({ items = [] }) {
  return (
    <Card>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="section-title">Recent Activity</h2>
          <p className="section-subtitle mt-1">Live platform events and decisions.</p>
        </div>
        <span className="text-xs font-semibold text-gray-500">{items.length} events</span>
      </div>
      <div className="space-y-3">
        {items.length === 0 ? (
          <EmptyState title="No activity yet" description="Actions and executions will appear here." />
        ) : items.map((item) => (
          <div
            key={item.id || `${item.title}-${item.createdAt}`}
            className="flex items-start gap-3 rounded-xl bg-backgroundLight p-3 dark:bg-darkBackgroundVery"
          >
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                tones[item.tone] || tones.blue
              }`}
            >
              <Icon icon={item.icon} className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {item.title}
              </p>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{item.meta}</p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default ActivityFeed;
