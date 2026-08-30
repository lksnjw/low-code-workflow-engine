import Card from "../shared/ui/Card";
import Button from "../shared/ui/Button";

/*******************************************************************************
 * Function: TemplateCard
 *
 * Performs the Template Card operation on card for the TemplateCard module.
 ******************************************************************************/
function TemplateCard({ title, description, steps, onUse, busy }) {
  return (
    <Card>
      <p className="text-xs font-bold uppercase text-primary">Template</p>
      <h3 className="mt-3 text-lg font-bold text-gray-950 dark:text-white">{title}</h3>
      <p className="mt-2 min-h-16 text-sm leading-6 text-gray-500 dark:text-gray-400">
        {description}
      </p>
      <div className="mt-5 flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-600 dark:text-gray-300">
          {steps} steps
        </span>
        <Button variant="secondary" onClick={onUse} disabled={busy}>{busy ? "Creating…" : "Use Template"}</Button>
      </div>
    </Card>
  );
}

export default TemplateCard;
