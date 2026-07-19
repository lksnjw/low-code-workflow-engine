import { Icon } from "@iconify/react";
import Card from "../shared/ui/Card";
import Button from "../shared/ui/Button";

function IntegrationCard({ integration }) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Icon icon={integration.icon} className="h-5 w-5" />
        </span>
        <span className="rounded-full bg-green-100 px-2.5 py-1 text-xs font-bold text-green-700 dark:bg-green-500/15 dark:text-green-300">
          {integration.status}
        </span>
      </div>
      <h3 className="mt-4 text-base font-bold text-gray-950 dark:text-white">
        {integration.name}
      </h3>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{integration.type}</p>
      <Button variant="secondary" className="mt-5 w-full" disabled>Use integration API to configure</Button>
    </Card>
  );
}

export default IntegrationCard;
