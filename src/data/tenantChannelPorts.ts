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

export interface TenantChannelStore {
  /** Current config for a tenant; defaults when no row exists (no row is created). */
  getTenantChannels(tenantId: string): Promise<TenantChannelConfig>;
  /** Merge a partial patch over the current config and return the result. */
  setTenantChannels(tenantId: string, patch: TenantChannelPatch): Promise<TenantChannelConfig>;
}
