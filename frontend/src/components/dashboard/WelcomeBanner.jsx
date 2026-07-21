import { Icon } from "@iconify/react";
import Button from "../shared/ui/Button";
import { useRoute } from "../../context/RouteContext";

function WelcomeBanner() {
  const { navigateTo, startWorkflow } = useRoute();

  return (
    <section className="overflow-hidden rounded-2xl border border-gray-200 bg-backgroundLight p-5 dark:border-darkBackgroundVery dark:bg-darkBackground">
      <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-center">
        <div className="max-w-[300px] sm:max-w-3xl">
          <h1 className="page-heading text-gray-950 dark:text-white">
            Agentic Workflow Command Center
          </h1>
          <p className="mt-3 max-w-[300px] text-sm leading-6 text-gray-600 dark:text-gray-300 sm:max-w-2xl">
            Build workflow blueprints from natural language, run them with guardrails,
            and monitor self-healing decisions from one operational console.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button onClick={startWorkflow}>
            <Icon icon="mdi:plus" className="h-5 w-5" />
            Build Flow
          </Button>
          <Button variant="secondary" onClick={() => navigateTo("chat", "session")}>
            <Icon icon="hugeicons:ai-magic" className="h-5 w-5" />
            Ask Agent
          </Button>
        </div>
      </div>
    </section>
  );
}

export default WelcomeBanner;
