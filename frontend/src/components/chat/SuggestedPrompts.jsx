const prompts = [
  "Build an invoice exception workflow",
  "Add self-healing retry to ERP connector",
  "Create a support triage workflow",
];

/*******************************************************************************
 * Function: SuggestedPrompts
 *
 * Performs the Suggested Prompts operation on prompts for the SuggestedPrompts module.
 ******************************************************************************/
function SuggestedPrompts({ onSelect }) {
  return (
    <div className="flex flex-wrap gap-2">
      {prompts.map((prompt) => (
        <button
          key={prompt}
          type="button"
          onClick={() => onSelect(prompt)}
          className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 transition hover:border-primary hover:text-primary dark:border-gray-800 dark:bg-darkBackground dark:text-gray-300"
        >
          {prompt}
        </button>
      ))}
    </div>
  );
}

export default SuggestedPrompts;
