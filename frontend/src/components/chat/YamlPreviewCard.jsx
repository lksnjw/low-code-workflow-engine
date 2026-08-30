import Card from "../shared/ui/Card";
import CodeBlock from "../shared/ui/CodeBlock";

/*******************************************************************************
 * Function: YamlPreviewCard
 *
 * Performs the Yaml Preview Card operation on preview card for the YamlPreviewCard module.
 ******************************************************************************/
function YamlPreviewCard({ yaml }) {
  return (
    <Card>
      <h3 className="text-base font-bold text-gray-950 dark:text-white">Generated YAML</h3>
      <div className="mt-4">
        <CodeBlock code={yaml || "No validated workflow YAML yet."} />
      </div>
    </Card>
  );
}

export default YamlPreviewCard;
