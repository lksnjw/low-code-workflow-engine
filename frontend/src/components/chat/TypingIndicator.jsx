/*******************************************************************************
 * Function: TypingIndicator
 *
 * Performs the Typing Indicator operation on indicator for the TypingIndicator module.
 ******************************************************************************/
function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 rounded-full bg-backgroundLight px-3 py-2 dark:bg-darkBackgroundVery">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="h-2 w-2 rounded-full bg-primary opacity-60"
          style={{ animation: `pulse-ring 1.4s ${index * 120}ms ease-out infinite` }}
        />
      ))}
    </div>
  );
}

export default TypingIndicator;
