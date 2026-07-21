package config

import "go.uber.org/zap"

type RedisCache struct {
	URL     string
	Online  bool
	Message string
}

func NewRedisCache(cfg Config, log *zap.Logger) RedisCache {
	cache := RedisCache{
		URL:     cfg.RedisURL,
		Online:  false,
		Message: "in-memory policy cache active; Redis URL configured for production swap",
	}

	// Redis URLs can also contain credentials, so log only the selected mode.
	log.Info("redis adapter prepared", zap.String("mode", "memory"))
	return cache
}
