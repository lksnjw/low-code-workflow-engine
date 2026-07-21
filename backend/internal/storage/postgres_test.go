package storage

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPostgresStoreRoundTrip(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set TEST_DATABASE_URL to run PostgreSQL integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	stateKey := fmt.Sprintf("test-%d", time.Now().UnixNano())
	stateStore, err := openPostgres(ctx, databaseURL, stateKey)
	if err != nil {
		t.Fatalf("openPostgres: %v", err)
	}
	defer stateStore.Close()
	defer stateStore.pool.Exec(context.Background(), `DELETE FROM runtime_state WHERE state_key = $1`, stateKey)

	if _, found, err := stateStore.Load(ctx); err != nil || found {
		t.Fatalf("initial Load = found %v, err %v", found, err)
	}
	codec, err := NewAESGCMCodec(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x37}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	plaintext := []byte(`{"providerApiKey":"postgres-integration-secret","users":["user_1"]}`)
	payload, err := codec.Encode(plaintext)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if err := stateStore.Save(ctx, payload); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded, found, err := stateStore.Load(ctx)
	if err != nil || !found {
		t.Fatalf("Load = found %v, err %v", found, err)
	}
	if !bytes.Equal(loaded, payload) {
		t.Fatalf("loaded payload = %q", loaded)
	}
	if strings.Contains(string(loaded), "postgres-integration-secret") {
		t.Fatal("PostgreSQL payload leaked plaintext provider credential")
	}
	decoded, err := codec.Decode(loaded)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if !bytes.Equal(decoded, plaintext) {
		t.Fatalf("decrypted payload = %q", decoded)
	}
}

func TestPostgresParseErrorRedactsPassword(t *testing.T) {
	const secret = "do-not-log-this-password"
	_, err := OpenPostgres(context.Background(), "postgres://user:"+secret+"@%zz")
	if err == nil {
		t.Fatal("expected invalid DATABASE_URL to fail")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatal("PostgreSQL configuration error leaked DSN password")
	}
}

func TestPostgresStoreEnforcesSingleWriterPerStateKey(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set TEST_DATABASE_URL to run PostgreSQL integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	stateKey := fmt.Sprintf("writer-lock-test-%d", time.Now().UnixNano())
	first, err := openPostgres(ctx, databaseURL, stateKey)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if second, secondErr := openPostgres(ctx, databaseURL, stateKey); secondErr == nil {
		second.Close()
		t.Fatal("second PostgreSQL writer unexpectedly acquired the same state key")
	}
	first.Close()
	reopened, err := openPostgres(ctx, databaseURL, stateKey)
	if err != nil {
		t.Fatalf("writer lock was not released on close: %v", err)
	}
	reopened.Close()
}
