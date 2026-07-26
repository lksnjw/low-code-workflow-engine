package config

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
)

type RuntimeRegistryState struct {
	ToolPath   string
	RulePath   string
	ToolSHA256 string
	RuleSHA256 string
	Writable   bool
}

// EnsureRuntimeRegistries creates only missing runtime files and never
// overwrites an existing registry.
func EnsureRuntimeRegistries(cfg Config) (RuntimeRegistryState, error) {
	seedMode := strings.ToLower(strings.TrimSpace(cfg.RuntimeRegistrySeed))
	if seedMode == "" {
		seedMode = "copy"
	}
	for _, path := range []string{cfg.ToolRegistryPath, cfg.RuleRegistryPath} {
		if err := registry.GuardRegistryWritePath(path); err != nil {
			return RuntimeRegistryState{}, err
		}
	}
	if err := ensureRuntimeRegistryFile(cfg.ToolRegistryPath, cfg.FrozenToolRegistryPath, seedMode); err != nil {
		return RuntimeRegistryState{}, fmt.Errorf("initialize runtime tool registry: %w", err)
	}
	if err := ensureRuntimeRegistryFile(cfg.RuleRegistryPath, cfg.FrozenRuleRegistryPath, seedMode); err != nil {
		return RuntimeRegistryState{}, fmt.Errorf("initialize runtime rule registry: %w", err)
	}
	toolHash, err := RegistryFileSHA256(cfg.ToolRegistryPath)
	if err != nil {
		return RuntimeRegistryState{}, fmt.Errorf("hash runtime tool registry: %w", err)
	}
	ruleHash, err := RegistryFileSHA256(cfg.RuleRegistryPath)
	if err != nil {
		return RuntimeRegistryState{}, fmt.Errorf("hash runtime rule registry: %w", err)
	}
	toolPath, err := filepath.Abs(cfg.ToolRegistryPath)
	if err != nil {
		return RuntimeRegistryState{}, err
	}
	rulePath, err := filepath.Abs(cfg.RuleRegistryPath)
	if err != nil {
		return RuntimeRegistryState{}, err
	}
	return RuntimeRegistryState{
		ToolPath: toolPath, RulePath: rulePath,
		ToolSHA256: toolHash, RuleSHA256: ruleHash, Writable: true,
	}, nil
}

func ensureRuntimeRegistryFile(targetPath, frozenPath, seedMode string) error {
	if strings.TrimSpace(targetPath) == "" {
		return fmt.Errorf("runtime registry path is required")
	}
	if _, err := os.Stat(targetPath); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	var raw []byte
	switch seedMode {
	case "copy":
		if strings.TrimSpace(frozenPath) == "" {
			return fmt.Errorf("frozen evaluation registry source path is required for copy seeding")
		}
		source, err := os.ReadFile(frozenPath)
		if err != nil {
			return fmt.Errorf("read frozen evaluation registry seed: %w", err)
		}
		raw = source
	case "empty":
		raw = []byte("[]\n")
	default:
		return fmt.Errorf("unsupported runtime registry seed mode %q", seedMode)
	}
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return err
	}
	file, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if os.IsExist(err) {
			return nil
		}
		return err
	}
	removeIncomplete := true
	defer func() {
		if removeIncomplete {
			_ = os.Remove(targetPath)
		}
	}()
	if _, err := file.Write(raw); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	removeIncomplete = false
	return nil
}

func RegistryFileSHA256(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}
