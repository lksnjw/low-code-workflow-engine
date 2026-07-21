package storage

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
)

const encryptedStateMagic = "LCWE_STATE_V1"

// Codec protects a state payload before it crosses the storage boundary.
type Codec interface {
	Encode([]byte) ([]byte, error)
	Decode([]byte) ([]byte, error)
}

// AESGCMCodec encrypts the complete runtime snapshot. Encrypting the complete
// envelope ensures provider credentials and arbitrary secret settings are
// never written to PostgreSQL in plaintext.
type AESGCMCodec struct {
	aead cipher.AEAD
}

// NewAESGCMCodec accepts a 32-byte key encoded as base64, hexadecimal, or a
// literal 32-byte value. The key must be supplied outside source control.
func NewAESGCMCodec(encodedKey string) (*AESGCMCodec, error) {
	key, err := decodeEncryptionKey(encodedKey)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("initialize storage cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("initialize storage AEAD: %w", err)
	}
	return &AESGCMCodec{aead: aead}, nil
}

func (c *AESGCMCodec) Encode(plaintext []byte) ([]byte, error) {
	if c == nil || c.aead == nil {
		return nil, errors.New("storage encryption codec is not initialized")
	}
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("generate storage encryption nonce: %w", err)
	}
	prefix := []byte(encryptedStateMagic)
	out := make([]byte, 0, len(prefix)+len(nonce)+len(plaintext)+c.aead.Overhead())
	out = append(out, prefix...)
	out = append(out, nonce...)
	out = c.aead.Seal(out, nonce, plaintext, prefix)
	return out, nil
}

func (c *AESGCMCodec) Decode(payload []byte) ([]byte, error) {
	if c == nil || c.aead == nil {
		return nil, errors.New("storage encryption codec is not initialized")
	}
	prefix := []byte(encryptedStateMagic)
	minimum := len(prefix) + c.aead.NonceSize() + c.aead.Overhead()
	if len(payload) < minimum || string(payload[:len(prefix)]) != encryptedStateMagic {
		return nil, errors.New("invalid encrypted storage payload")
	}
	nonceStart := len(prefix)
	nonceEnd := nonceStart + c.aead.NonceSize()
	nonce := payload[nonceStart:nonceEnd]
	plaintext, err := c.aead.Open(nil, nonce, payload[nonceEnd:], prefix)
	if err != nil {
		return nil, errors.New("decrypt storage payload: key mismatch or data tampering detected")
	}
	return plaintext, nil
}

func decodeEncryptionKey(value string) ([]byte, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, errors.New("STORAGE_ENCRYPTION_KEY is required for PostgreSQL storage")
	}

	if decoded, err := base64.StdEncoding.DecodeString(value); err == nil && len(decoded) == 32 {
		return decoded, nil
	}
	if decoded, err := hex.DecodeString(value); err == nil && len(decoded) == 32 {
		return decoded, nil
	}
	if len([]byte(value)) == 32 {
		return []byte(value), nil
	}
	return nil, errors.New("STORAGE_ENCRYPTION_KEY must contain exactly 32 bytes (base64, hex, or literal)")
}
