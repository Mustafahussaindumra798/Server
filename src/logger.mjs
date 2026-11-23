const SENSITIVE_KEYS = new Set([
  "token",
  "credential",
  "secret",
  "password",
  "private_key",
  "authorization",
  "enrollment_token",
  "lease_token",
  "key",
  "access_token",
  "refresh_token",
  "token_hash",
  "credential_hash"
]);

const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export function redactSensitive(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Redact bearer tokens in strings
    return value.replace(/Bearer\s+[A-Za-z0-9._~+/-]{10,}/gi, "Bearer [REDACTED]");
  }
  if (typeof value !== "object") return value;

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, seen));
  }

  const clean = {};
  for (const [k, v] of Object.entries(value)) {
    const lowerKey = k.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey) || lowerKey.endsWith("_token") || lowerKey.endsWith("_secret") || lowerKey.endsWith("_key")) {
      clean[k] = "[REDACTED]";
    } else {
      clean[k] = redactSensitive(v, seen);
    }
  }
  return clean;
}

export function createStructuredLogger({
  minLevel = "info",
  service = "cloudexify-control-plane",
  sink = (line) => process.stdout.write(line + "\n")
} = {}) {
  const currentThreshold = LOG_LEVELS[minLevel] ?? LOG_LEVELS.info;

  function log(level, message, context = {}) {
    if ((LOG_LEVELS[level] ?? 20) < currentThreshold) return;
    const entry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      service,
      message: typeof message === "string" ? message : JSON.stringify(message),
      ...redactSensitive(context)
    };
    try {
      sink(JSON.stringify(entry));
    } catch {
      // Fail-safe sink fallback
    }
  }

  return {
    debug: (msg, ctx) => log("debug", msg, ctx),
    info: (msg, ctx) => log("info", msg, ctx),
    warn: (msg, ctx) => log("warn", msg, ctx),
    error: (msg, ctx) => log("error", msg, ctx),
    log
  };
}
