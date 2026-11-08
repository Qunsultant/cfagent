/**
 * Shared safe number and price formatters for client surfaces.
 * Issue #3731: Guards against undefined/null/NaN values on live & paper quotes,
 * preventing unhandled TypeError exceptions during render.
 */

export function safeNumberFormat(value: unknown, decimals = 2, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num.toFixed(decimals);
}

export function safePriceFormat(value: unknown, decimals = 2, fallback = "—"): string {
  const formatted = safeNumberFormat(value, decimals, fallback);
  return formatted === fallback ? fallback : `$${formatted}`;
}

