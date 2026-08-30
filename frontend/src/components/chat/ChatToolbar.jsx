import { Icon } from "@iconify/react";

const MODES = [
  { value: "generate_workflow", label: "Generate Workflow" },
  { value: "validate_only", label: "Validate Only" },
  { value: "dry_run", label: "Dry Run" },
];

/*******************************************************************************
 * Function: SelectPill
 *
 * Performs the Select Pill operation on pill for the ChatToolbar module.
 ******************************************************************************/
function SelectPill({ value, onChange, options, icon }) {
  return (
    <label className="relative flex cursor-pointer items-center gap-1.5 rounded-lg border border-gray-200 bg-backgroundLight px-2.5 py-1.5 text-xs font-semibold text-gray-700 transition hover:border-primary/40 dark:border-gray-700 dark:bg-darkBackgroundVery dark:text-gray-200">
      {icon && <Icon icon={icon} className="h-3.5 w-3.5 text-primary" />}
      <span>{options.find((o) => o.value === value)?.label ?? value}</span>
      <Icon icon="mdi:chevron-down" className="h-3.5 w-3.5 text-gray-400" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

/*******************************************************************************
 * Function: ChatToolbar
 *
 * Performs the Chat Toolbar operation on toolbar for the ChatToolbar module.
 ******************************************************************************/
function ChatToolbar({ mode, onModeChange }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-800">
      <div className="min-w-0">
        <h2 className="text-sm font-bold text-gray-950 dark:text-white">Workflow Synthesis</h2>
        <p className="truncate text-xs text-gray-500 dark:text-gray-400">
          Natural language to YAML with policy validation.
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <span className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-semibold text-gray-500 dark:border-gray-700">Environment model</span>
        <SelectPill
          value={mode}
          onChange={onModeChange}
          options={MODES}
          icon="mdi:cog-outline"
        />
      </div>
    </div>
  );
}

export default ChatToolbar;
