/** Workflow permissions do not grant access to private conversations. Role
 * names come from authenticated server state, never from the request body. */
export function canReviewChat(user: { id: string; role?: string }, chat: { ownerId: string }): boolean {
  return chat.ownerId === user.id || user.role === "Platform Admin";
}

export function chatAccess(user: { id: string; role?: string }, chat: { ownerId: string }) {
  return { canReply: chat.ownerId === user.id, canManage: chat.ownerId === user.id, reviewOnly: chat.ownerId !== user.id };
}
