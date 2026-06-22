type LogLevel = "info" | "warn" | "error";

function sanitizeMeta(meta?: Record<string, unknown>): Record<string, unknown> {
  if (!meta) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(meta).map(([key, value]) => {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes("token") ||
        lowerKey.includes("secret") ||
        lowerKey.includes("authorization") ||
        lowerKey.includes("apikey") ||
        lowerKey.includes("api_key")
      ) {
        return [key, "[redacted]"];
      }
      return [key, value];
    }),
  );
}

export function appLog(
  scope: string,
  message: string,
  meta?: Record<string, unknown>,
  level: LogLevel = "info",
) {
  const payload = {
    scope,
    message,
    ...sanitizeMeta(meta),
  };

  if (level === "error") {
    console.error(JSON.stringify(payload));
    return;
  }

  if (level === "warn") {
    console.warn(JSON.stringify(payload));
    return;
  }

  console.log(JSON.stringify(payload));
}
