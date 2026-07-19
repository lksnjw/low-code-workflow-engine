import { apiClient } from "../config/axios";
import { unwrap } from "./api";

const tones = ["violet", "emerald", "blue", "amber", "sky", "purple", "green", "rose"];
const icons = { hr: "UserSearch", inventory: "Boxes", procurement: "ShoppingCart", finance: "FileCheck2", warehouse: "Warehouse" };

export const catalogService = {
  async tools(params = {}) {
    return unwrap(await apiClient.get("/tools/catalog", { params }), []) || [];
  },
  async toolGroups() {
    const tools = await this.tools({ status: "available" });
    const groups = new Map();
    tools.forEach((tool, index) => {
      const moduleName = tool.module || tool.erp_system || "General";
      const key = String(moduleName);
      if (!groups.has(key)) groups.set(key, []);
      const parameters = Object.fromEntries((tool.required_parameters || []).map((name) => [name, `{{input.${name}}}`]));
      groups.get(key).push({
        label: tool.display_name || tool.name,
        action: tool.name,
        description: tool.description || "Registered workflow tool",
        iconKey: icons[String(moduleName).toLowerCase()] || "Database",
        role: tool.allowed_roles?.[0] || "configured role",
        roles: tool.allowed_roles || [],
        tone: tones[index % tones.length],
        parameters,
      });
    });
    return Array.from(groups, ([title, groupedTools]) => ({ title, description: `${groupedTools.length} registered tools`, tools: groupedTools }));
  },
};
