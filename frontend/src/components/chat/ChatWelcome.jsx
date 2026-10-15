import { Icon } from "@iconify/react";

const CAPABILITIES = [
  { icon: "mdi:auto-fix", label: "Build a workflow", desc: "Describe the outcome you need" },
  { icon: "mdi:shield-check-outline", label: "Check safety", desc: "Permissions and validation stay enforced" },
  { icon: "mdi:database-search-outline", label: "Use approved ERP tools", desc: "See every confirmed result" },
  { icon: "mdi:graph-outline", label: "Review before running", desc: "Nothing executes automatically" },
];

/*******************************************************************************
 * Function: ChatWelcome
 *
 * Performs the Chat Welcome operation on welcome for the ChatWelcome module.
 ******************************************************************************/
function ChatWelcome({ onPrompt = () => {}, prompts = [], variant = "workflow" }) {
  const indexed = variant === "indexed";
  return (
    <div className="space-y-7 py-5">
      {/* Hero */}
      <div className="text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
          <Icon icon="hugeicons:ai-magic" className="h-6 w-6 text-primary" />
        </div>
        <h2 className="text-xl font-bold text-gray-950 dark:text-white">{indexed ? "Find stored document details" : "What would you like to do?"}</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-gray-500 dark:text-gray-400">
          {indexed ? "Ask for a person, customer or document in your own words. The assistant searches your permitted saved documents through the backend." : "Describe the result you need. Follow each step as your request is checked, prepared and completed."}
        </p>
      </div>

      {/* Compact trust and capability list */}
      {!indexed && <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {CAPABILITIES.map((cap) => (
          <div
            key={cap.label}
            className="flex items-start gap-2.5"
          >
            <Icon icon={cap.icon} className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <div>
              <p className="text-xs font-semibold text-gray-800 dark:text-white">{cap.label}</p>
              <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">{cap.desc}</p>
            </div>
          </div>
        ))}
      </div>}

      {/* Quick-start prompts */}
      {prompts.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-gray-500 dark:text-gray-400">Or start with an example</p>
          <div className="space-y-1.5">
            {prompts.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => onPrompt(p.text)}
                className="group flex w-full items-center gap-3 border-b border-gray-100 px-1 py-3 text-left transition hover:text-primary dark:border-gray-800"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <Icon icon={p.icon} className="h-4 w-4 text-primary" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-gray-800 group-hover:text-primary dark:text-white">{p.label}</p>
                  <p className="mt-0.5 truncate text-[11px] text-gray-500 dark:text-gray-400">{p.text.slice(0, 80)}…</p>
                </div>
                <Icon icon="mdi:chevron-right" className="ml-auto h-4 w-4 shrink-0 text-gray-300" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default ChatWelcome;
