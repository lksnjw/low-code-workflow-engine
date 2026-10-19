import { allRolesToolAccess } from "../../governance/tool-access.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Workflows catalog (feasibility policy) ──────────────────────────────────
interface CatalogWorkflow {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  allowed_roles: string[];
  requires_write: boolean;
  domain: string;
  doable: boolean;
}
interface WorkflowsCatalog {
  workflows: CatalogWorkflow[];
  globally_blocked: string[];
  role_notes: Record<string, string>;
}

let _catalogCache: WorkflowsCatalog | null = null;
/*******************************************************************************
 * Function: loadWorkflowsCatalog
 *
 * Loads and caches the workflow catalog and blocked-request patterns.
 ******************************************************************************/
function loadWorkflowsCatalog(): WorkflowsCatalog {
  if (_catalogCache !== null) return _catalogCache;
  try {
    const path = resolve(process.cwd(), "policy/workflows_catalog.json");
    _catalogCache = JSON.parse(readFileSync(path, "utf8")) as WorkflowsCatalog;
  } catch {
    _catalogCache = { workflows: [], globally_blocked: [], role_notes: {} };
  }
  return _catalogCache;
}


function keywordScore(normalizedRequest: string, keyword: string): number {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (normalizedKeyword === "") return 0;
  const tokens = normalizedKeyword.match(/[a-z0-9]+/g);
  if (tokens === null || tokens.length === 0) return 0;
  const separator = "[^a-z0-9]+(?:(?:a|an|the)[^a-z0-9]+)?";
  return new RegExp("(?:^|[^a-z0-9])" + tokens.join(separator) + "(?:$|[^a-z0-9])", "i").test(normalizedRequest) ? tokens.length : 0;
}

/*******************************************************************************
 * Function: checkFeasibility
 *
 * Checks a workflow request against catalog support and blocking rules.
 ******************************************************************************/
export function checkFeasibility(request: string, userRole: string): { feasible: boolean; matchedWorkflow?: CatalogWorkflow; reason?: string } {
  const catalog = loadWorkflowsCatalog();
  const normalized = request.toLowerCase();

  // Check globally blocked phrases
  for (const blocked of catalog.globally_blocked) {
    if (normalized.includes(blocked.toLowerCase())) {
      return { feasible: false, reason: `This action ("${blocked}") is globally blocked and cannot be automated in this system.` };
    }
  }

  // Find best matching workflow by keyword scoring
  let bestMatch: CatalogWorkflow | undefined;
  let bestScore = 0;
  for (const workflow of catalog.workflows) {
    const score = workflow.keywords.reduce((acc, keyword) => acc + keywordScore(normalized, keyword), 0);
    if (score > bestScore) { bestScore = score; bestMatch = workflow; }
  }

  if (bestMatch === undefined || bestScore === 0) {
    // No advisory catalog match makes no authorization decision. Mandatory live
    // discovery, validation, role grants and execution admission still apply.
    return { feasible: true };
  }

  if (!bestMatch.doable) {
    return { feasible: false, matchedWorkflow: bestMatch, reason: `"${bestMatch.name}" is not supported in this ERP system.` };
  }

  const normalizedRole = userRole.trim();
  const allowed = allRolesToolAccess() || bestMatch.allowed_roles.some((r) => r.toLowerCase() === normalizedRole.toLowerCase()) || normalizedRole === "Platform Admin";
  if (!allowed) {
    const roleNote = catalog.role_notes[normalizedRole] ?? `Role "${normalizedRole}" does not have access to this workflow.`;
    return {
      feasible: false,
      matchedWorkflow: bestMatch,
      reason: `Your role (**${normalizedRole}**) is not permitted to run "${bestMatch.name}".\n\n${roleNote}`,
    };
  }

  if (bestMatch.requires_write && normalizedRole === "Client") {
    return { feasible: false, matchedWorkflow: bestMatch, reason: `"${bestMatch.name}" requires write access. The **Client** role is read-only.` };
  }

  return { feasible: true, matchedWorkflow: bestMatch };
}
