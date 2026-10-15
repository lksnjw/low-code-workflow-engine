import { HandlerFailure } from "./common.js";

/** Creation and rename use one title contract; malformed values never
 * silently replace a saved title with the default. */
export function chatTitle(body: Record<string, unknown>): string {
  if (!Object.hasOwn(body, "title")) return "New conversation";
  if (typeof body.title !== "string" || body.title.length > 200) throw new HandlerFailure(400, "Invalid chat title");
  return body.title.trim() === "" ? "New conversation" : body.title.trim();
}
