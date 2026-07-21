package storage

import (
	"context"
	"testing"
)

func TestOpenMemoryAndRejectUnknownDriver(t *testing.T) {
	stateStore, err := Open(context.Background(), "memory", "")
	if err != nil {
		t.Fatalf("Open(memory): %v", err)
	}
	if stateStore != nil {
		t.Fatal("memory driver should not install a persistence backend")
	}
	if _, err := Open(context.Background(), "unknown", ""); err == nil {
		t.Fatal("expected unknown driver to fail")
	}
	if _, err := Open(context.Background(), "postgres", ""); err == nil {
		t.Fatal("expected postgres without DATABASE_URL to fail")
	}
}
