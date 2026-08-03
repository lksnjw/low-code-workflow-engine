function StepLogItem({ log, index, tone }) {
  const blocked = tone === "blocked";
  return (
    <div className="flex gap-3">
      <span
        className={`mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${
          blocked ? "bg-amber-500" : "bg-primary"
        }`}
      >
        {index + 1}
      </span>
      <p
        className={`rounded-xl px-4 py-3 text-sm ${
          blocked
            ? "bg-amber-50 font-semibold text-amber-900 dark:bg-amber-500/10 dark:text-amber-200"
            : "bg-backgroundLight text-gray-700 dark:bg-darkBackgroundVery dark:text-gray-200"
        }`}
      >
        {log}
      </p>
    </div>
  );
}

export default StepLogItem;
