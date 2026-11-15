/**
 * Issue #3169 (program #2218) — tenant delivery-channel port.
 *
 * Tenant-level delivery-channel enablement flags: one boolean
 * per delivery channel (email, Slack, webhook, Copilot card,
 * Docs) for one tenant. Enablement flags ONLY — this store
 * never holds a webhook URL, token, or secret (v1 scope):
 * secrets stay in worker bindings, and recipients stay
 * per-run / per-schedule, never in this table.
 *
 * ADR 0002 port-first: domain code depends only on this
 * interface. Only the adapters (Drizzle D1, in-memory) touch
 * a store, and only the composition root
 * (createTenantChannelPorts.ts) maps a Worker binding to an
 * adapter. A tenant with no row reads as all-enabled: an
 * operator disable is an explicit act, and configuring nothing
 * changes nothing (existing dispatch behavior is preserved).
 */
export type TenantChannelId = "email" | "slack" | "webhook" | "copilot" | "docs";

/** The five delivery channels, in panel order. */
export const TENANT_CHANNEL_IDS: readonly TenantChannelId[] = [
  "email",
  "slack",
  "webhook",
  "copilot",
  "docs",
];

/** Enablement flags for one tenant's five delivery channels. */
export interface TenantChannelConfig {
  email: boolean;
  slack: boolean;
  webhook: boolean;
  copilot: boolean;
  docs: boolean;
}

/** Absent-row semantics: every channel permitted. */
export const DEFAULT_TENANT_CHANNELS: TenantChannelConfig = {
  email: true,
  slack: true,
  webhook: true,
  copilot: true,
  docs: true,
};

/** Partial patch: only the supplied flags change. */
export type TenantChannelPatch = Partial<TenantChannelConfig>;

const MAX_SLACK_CHANNEL_LENGTH = 128;

/**
 * Issue #4610 (G15): validate and normalize a per-tenant Slack channel id
 * (or null to clear a tenant's mapping). Rejects empty strings, whitespace/control
 * characters, and URLs/tokens.
 */
export function normalizeTenantSlackChannel(
  value: unknown,
): { ok: true; slackChannel: string | null } | { ok: false; error: string } {
  if (value === null) {
    return { ok: true, slackChannel: null };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "slackChannel must be a non-empty string or null." };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: "slackChannel must not be empty." };
  }
  if (trimmed.length > MAX_SLACK_CHANNEL_LENGTH) {
    return {
      ok: false,
      error: `slackChannel must be ${MAX_SLACK_CHANNEL_LENGTH} characters or fewer.`,
    };
  }
  if (/[\s\x00-\x1F\x7F]/.test(trimmed)) {
    return { ok: false, error: "slackChannel must not contain whitespace or control characters." };
  }
  if (/^https?:\/\//i.test(trimmed) || /^xox[bpasr]-/i.test(trimmed)) {
    return {
      ok: false,
      error: "slackChannel must be a Slack channel identifier, not a URL or token.",
    };
  }
  return { ok: true, slackChannel: trimmed };
}

export interface TenantChannelStore {
  /** Current config for a tenant; defaults when no row exists (no row is created). */
  getTenantChannels(tenantId: string): Promise<TenantChannelConfig>;
  /** Merge a partial patch over the current config and return the result. */
  setTenantChannels(tenantId: string, patch: TenantChannelPatch): Promise<TenantChannelConfig>;
  /**
   * Issue #4610 (G15): per-tenant Slack channel mapping.
   * Returns the mapped Slack channel id for the tenant, or null when unmapped.
   */
  getTenantSlackChannel?(tenantId: string): Promise<string | null>;
  /**
   * Issue #4610 (G15): set or clear (null) the per-tenant Slack channel mapping.
   */
  setTenantSlackChannel?(tenantId: string, slackChannel: string | null): Promise<string | null>;
}
