package storage

import (
	"bytes"
	"encoding/base64"
	"testing"
)

func TestAESGCMCodecRoundTripAndNoPlaintext(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x2a}, 32))
	codec, err := NewAESGCMCodec(key)
	if err != nil {
		t.Fatalf("NewAESGCMCodec: %v", err)
	}
	plaintext := []byte(`{"apiKey":"super-secret-provider-key"}`)
	payload, err := codec.Encode(plaintext)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if bytes.Contains(payload, []byte("super-secret-provider-key")) {
		t.Fatal("encrypted payload contains plaintext secret")
	}
	decoded, err := codec.Decode(payload)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if !bytes.Equal(decoded, plaintext) {
		t.Fatalf("round trip mismatch: got %q", decoded)
	}
}

func TestAESGCMCodecRejectsWrongKeyAndTampering(t *testing.T) {
	codecA, err := NewAESGCMCodec(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x11}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	codecB, err := NewAESGCMCodec(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x22}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	payload, err := codecA.Encode([]byte("protected"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := codecB.Decode(payload); err == nil {
		t.Fatal("expected wrong key to be rejected")
	}

	tampered := append([]byte(nil), payload...)
	tampered[len(tampered)-1] ^= 0xff
	if _, err := codecA.Decode(tampered); err == nil {
		t.Fatal("expected tampered ciphertext to be rejected")
	}
}

func TestAESGCMCodecValidatesKey(t *testing.T) {
	for _, key := range []string{"", "short", base64.StdEncoding.EncodeToString([]byte("too-short"))} {
		if _, err := NewAESGCMCodec(key); err == nil {
			t.Fatalf("expected invalid key %q to fail", key)
		}
	}
}
