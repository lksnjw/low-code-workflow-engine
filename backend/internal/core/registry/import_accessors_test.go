package registry

import (
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestFrozenPathGuardRejectsAbsoluteAndRelativeForms(t *testing.T) {
	frozenPath := filepath.Join(t.TempDir(), "configs", "registries", "all_tools_master_registry.json")
	if err := GuardRegistryWritePath(frozenPath); err == nil {
		t.Fatal("absolute frozen evaluation path was accepted")
	}
	relativePath := filepath.Join("configs", "registries", "all_tools_master_registry.json")
	if err := GuardRegistryWritePath(relativePath); err == nil {
		t.Fatal("relative frozen evaluation path was accepted")
	}
	runtimePath := filepath.Join(t.TempDir(), "configs", "runtime", "all_tools_master_registry.json")
	if err := GuardRegistryWritePath(runtimePath); err != nil {
		t.Fatalf("runtime path was rejected: %v", err)
	}
}

func TestRollbackRepublishHoldsManagerLock(t *testing.T) {
	live := &Bundle{
		Tools:    NewToolRegistry([]Tool{}, "live-tools"),
		Rules:    NewRuleRegistry([]Rule{}, "live-rules"),
		Versions: RegistryVersions{Tools: "live-tools", Rules: "live-rules"},
	}
	restored := &Bundle{
		Tools:    NewToolRegistry([]Tool{{ToolID: "restored"}}, "restored-tools"),
		Rules:    NewRuleRegistry([]Rule{{RuleID: "restored"}}, "restored-rules"),
		Versions: RegistryVersions{Tools: "restored-tools", Rules: "restored-rules"},
	}
	manager := NewManager(live, "tools.json", "rules.json")
	manager.mu.Lock()
	locked := true
	t.Cleanup(func() {
		if locked {
			manager.mu.Unlock()
		}
	})
	done := make(chan error, 1)
	go func() {
		done <- manager.RepublishRestoredBundle(restored)
	}()
	select {
	case err := <-done:
		t.Fatalf("republish bypassed manager lock: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	manager.mu.Unlock()
	locked = false
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("republish did not complete after manager lock was released")
	}
	if live.Tools.Version() != "restored-tools" || live.Rules.Version() != "restored-rules" {
		t.Fatalf("restored versions were not republished: %+v", live.Versions)
	}
}

func TestToolUpsertCallbackCannotBeReplacedExternally(t *testing.T) {
	bundle := &Bundle{
		Tools: NewToolRegistry([]Tool{}, "tools"),
		Rules: NewRuleRegistry([]Rule{}, "rules"),
	}
	manager := NewManager(bundle, "tools.json", "rules.json")
	calls := 0
	manager.SetToolUpsert(func(Tool) { calls++ })
	suspension := manager.SuspendToolUpsertCallback()

	restore, exists := reflect.TypeOf(suspension).MethodByName("Restore")
	if !exists || restore.Type.NumIn() != 1 {
		t.Fatalf("Restore accepts a replacement value: method=%+v exists=%v", restore, exists)
	}
	restoreAndNotify, exists := reflect.TypeOf(suspension).MethodByName("RestoreAndNotify")
	if !exists || restoreAndNotify.Type.NumIn() != 2 || restoreAndNotify.Type.In(1) != reflect.TypeOf([]Tool{}) {
		t.Fatalf("RestoreAndNotify exposes a callback replacement parameter: method=%+v exists=%v", restoreAndNotify, exists)
	}
	suspension.RestoreAndNotify([]Tool{{ToolID: "published"}})
	if calls != 1 {
		t.Fatalf("captured callback was not restored and notified exactly once: calls=%d", calls)
	}
	suspension.RestoreAndNotify([]Tool{{ToolID: "duplicate"}})
	if calls != 1 {
		t.Fatalf("one-use suspension restored or notified twice: calls=%d", calls)
	}
}
