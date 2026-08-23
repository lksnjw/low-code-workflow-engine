const secretFragments = ["password", "token", "api_key", "apikey", "secret", "authorization", "auth_header", "private_key"] as const;

export function isSecretField(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return secretFragments.some((fragment) => normalized.includes(fragment));
}

export function withoutSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecretFields);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSecretField(key))
      .map(([key, item]) => [key, withoutSecretFields(item)]),
  );
}

export function sensitiveFieldNames(): string[] {
  return [...secretFragments];
}
