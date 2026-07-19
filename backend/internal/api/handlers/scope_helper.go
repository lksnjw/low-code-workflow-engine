package handlers

import (
	"strings"

	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

func userHasPermission(user *models.User, permission string) bool {
	if user == nil {
		return false
	}
	for _, granted := range user.Permissions {
		if granted == permission {
			return true
		}
	}
	return false
}

func workflowAssignedToUser(workflow *models.Workflow, user *models.User) bool {
	if workflow == nil || user == nil {
		return false
	}
	if workflow.Owner.ID == user.ID {
		return true
	}
	for _, userID := range workflow.AssignedUserIDs {
		if userID == user.ID {
			return true
		}
	}
	return false
}

func canReadWorkflow(user *models.User, workflow *models.Workflow) bool {
	if userHasPermission(user, "workflow:read") {
		return true
	}
	return userHasPermission(user, "workflow:read_own") && workflowAssignedToUser(workflow, user)
}

func canRunWorkflow(user *models.User, workflow *models.Workflow) bool {
	if userHasPermission(user, "workflow:run") {
		return true
	}
	return userHasPermission(user, "workflow:run_own") && workflowAssignedToUser(workflow, user)
}

func canReadExecution(user *models.User, execution *models.Execution) bool {
	if userHasPermission(user, "workflow:read") {
		return true
	}
	return userHasPermission(user, "execution:read_own") && execution != nil && execution.StartedBy.ID == user.ID
}

func canAccessChatSession(user *models.User, session *models.ChatSessionDetail) bool {
	if userHasPermission(user, "workflow:read") || userHasPermission(user, "workflow:write") {
		return true
	}
	return userHasPermission(user, "chat:use") && session != nil && session.OwnerID == user.ID
}

func appendUniqueUserID(items []string, userID string) []string {
	for _, item := range items {
		if item == userID {
			return items
		}
	}
	return append(items, userID)
}

func removeUserID(items []string, userID string) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		if !strings.EqualFold(item, userID) {
			out = append(out, item)
		}
	}
	return out
}
