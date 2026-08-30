import { Icon } from "@iconify/react";

const CAPABILITIES = [
  { icon: "mdi:auto-fix", label: "Generate workflows", desc: "Describe what you need in plain language" },
  { icon: "mdi:shield-check-outline", label: "Policy validation", desc: "Every workflow is checked against your rules" },
  { icon: "mdi:database-search-outline", label: "Query ERP data", desc: "Ask for live data from connected systems" },
  { icon: "mdi:graph-outline", label: "Pass to Canvas", desc: "Validated workflows go straight to the executor" },
];

/*******************************************************************************
 * Function: ChatWelcome
 *
 * Performs the Chat Welcome operation on welcome for the ChatWelcome module.
 ******************************************************************************/
function ChatWelcome({ onPrompt = () => {}, prompts = [] }) {
  return (
    <div className="space-y-6 py-4">
      {/* Hero */}
      <div className="text-center">
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
          <Icon icon="hugeicons:ai-magic" className="h-8 w-8 text-primary" />
        </div>
        <h2 className="text-xl font-black text-gray-950 dark:text-white">Workflow Assistant</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Generate, query, and validate workflows with natural language.
        </p>
      </div>

      {/* Capability pills */}
      <div className="grid grid-cols-2 gap-2">
        {CAPABILITIES.map((cap) => (
          <div
            key={cap.label}
            className="flex items-start gap-2.5 rounded-xl border border-gray-100 bg-gray-50 p-3 dark:border-gray-800 dark:bg-darkBackgroundVery"
          >
            <Icon icon={cap.icon} className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div>
              <p className="text-xs font-semibold text-gray-800 dark:text-white">{cap.label}</p>
              <p className="text-[10px] text-gray-400">{cap.desc}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Quick-start prompts */}
      {prompts.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Try an example</p>
          <div className="space-y-1.5">
            {prompts.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => onPrompt(p.text)}
                className="flex w-full items-center gap-3 rounded-xl border border-gray-100 bg-white p-3 text-left transition hover:border-primary/30 hover:bg-primary/5 dark:border-gray-800 dark:bg-darkBackgroundVery dark:hover:border-primary/40"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <Icon icon={p.icon} className="h-4 w-4 text-primary" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-gray-800 dark:text-white">{p.label}</p>
                  <p className="truncate text-[10px] text-gray-400">{p.text.slice(0, 80)}…</p>
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
