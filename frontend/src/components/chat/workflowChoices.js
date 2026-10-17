import { parseWorkflowPreview, workflowArtifacts, workflowSource } from "./workflowPreview";

const displayName = value => typeof value === "string" ? value.trim().slice(0, 200) : "";
const artifactName = artifact => {
  const preview = parseWorkflowPreview(workflowSource(artifact));
  return preview.error ? "" : displayName(preview.name);
};

// Presentation projection only. All original messages/proposals remain intact;
// saved workflow source and revision still come from the authoritative editor.
export function workflowChoices(messages, workflowCatalog = []) {
  const choices = [], saved = new Map();
  for (const item of Array.isArray(workflowCatalog) ? workflowCatalog : []) {
    const id = item?.workflowId;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || saved.has(id)) continue;
    const choice = { key: `workflow:${id}`, name: displayName(item.name), artifact: { workflowId: id }, aliases: [`handoff:${id}`],
      lastSeen: Number.isSafeInteger(item.lastMessageIndex) ? item.lastMessageIndex : -1 };
    choices.push(choice); saved.set(id, choice);
  }
  const offset = choices.length ? Math.max(-1, ...choices.map(choice => choice.lastSeen)) + 1 : 0;
  for (const [index, item] of workflowArtifacts(messages).entries()) {
    const id = item.artifact.workflowId;
    if (typeof id !== "string" || !id.trim()) {
      choices.push({ ...item, name: artifactName(item.artifact), key: `message:${item.key}`, aliases: [item.key], lastSeen: offset + index });
      continue;
    }
    const existing = saved.get(id);
    if (existing) {
      existing.artifact = item.artifact;
      // Current authorized catalog names outrank historical message source.
      if (!existing.name) existing.name = artifactName(item.artifact);
      existing.lastSeen = offset + index;
      if (!existing.aliases.includes(item.key)) existing.aliases.push(item.key);
    } else {
      const choice = { key: `workflow:${id}`, name: artifactName(item.artifact), artifact: item.artifact, aliases: [item.key, `handoff:${id}`], lastSeen: offset + index };
      choices.push(choice); saved.set(id, choice);
    }
  }
  return choices;
}

export function selectedWorkflowChoice(choices, key) {
  return choices.find(item => item.key === key) ?? choices.find(item => item.aliases?.includes(key)) ??
    choices.reduce((latest, item) => !latest || item.lastSeen >= latest.lastSeen ? item : latest, null);
}
