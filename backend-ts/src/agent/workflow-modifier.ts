import type { ProviderRuntime } from "../providers/runtime.js";

export type WorkflowModifyResult = {
  yaml: string;
  changeDescription: string;
  ok: boolean;
  errorMessage?: string;
};

const SYSTEM_PROMPT = `You are a workflow YAML editor. The user will give you an existing workflow YAML and a natural-language modification instruction.

OUTPUT RULES:
1. Output ONLY the modified YAML, inside a \`\`\`yaml code block. Nothing else before or after.
2. Preserve all existing fields not mentioned in the modification.
3. Keep YAML valid and properly indented.
4. Do not add comments to the YAML.
5. If the modification is impossible or would break the workflow, output the ORIGINAL YAML unchanged and add a YAML comment on line 1: # UNCHANGED: <reason>`;

export async function modifyWorkflow(
  currentYaml: string,
  instruction: string,
  providerRuntime: ProviderRuntime,
  signal?: AbortSignal,
): Promise<WorkflowModifyResult> {
  if (!providerRuntime.configured) {
    return { yaml: currentYaml, changeDescription: "", ok: false, errorMessage: "No LLM provider is configured." };
  }

  const prompt = [
    `CURRENT WORKFLOW YAML:\n\`\`\`yaml\n${currentYaml}\n\`\`\``,
    "",
    `MODIFICATION INSTRUCTION: ${instruction}`,
    "",
    "Output the modified YAML inside a ```yaml block:",
  ].join("\n");

  let rawText: string;
  try {
    const response = await providerRuntime.generate(
      `${SYSTEM_PROMPT}\n\n---\n\n${prompt}`,
      "prompt/workflow-modifier/v1",
      signal,
    );
    rawText = response.text.trim();
  } catch (error) {
    return {
      yaml: currentYaml,
      changeDescription: "",
      ok: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  const match = rawText.match(/```yaml\s*([\s\S]*?)```/);
  if (!match || match[1] === undefined) {
    return { yaml: currentYaml, changeDescription: "", ok: false, errorMessage: "LLM did not return a valid YAML block." };
  }

  const newYaml = match[1].trim();
  if (newYaml.startsWith("# UNCHANGED:")) {
    const reason = newYaml.split("\n")[0]?.replace("# UNCHANGED:", "").trim() ?? "Modification not possible";
    return { yaml: currentYaml, changeDescription: "", ok: false, errorMessage: reason };
  }

  const changeDescription = describeChange(currentYaml, newYaml, instruction);
  return { yaml: newYaml, changeDescription, ok: true };
}

function describeChange(before: string, after: string, instruction: string): string {
  const beforeLines = before.split("\n").length;
  const afterLines = after.split("\n").length;
  const delta = afterLines - beforeLines;
  const deltaStr = delta > 0 ? `+${delta} lines` : delta < 0 ? `${delta} lines` : "same length";
  return `Applied: "${instruction.slice(0, 80)}" (${deltaStr})`;
}
