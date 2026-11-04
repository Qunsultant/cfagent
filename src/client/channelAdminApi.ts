/**
 * Client for the tenant delivery-channel administration
 * endpoints (issue #3169):
 * GET /api/platform-channels/:id,
 * PATCH /api/platform-channels/:id/channels.
 *
 * Operator-only: a 403 here means the server refused (the
 * caller is not a store operator), never a client bug.
 * Enablement flags only — this module never sends a URL,
 * token, or secret (the v1 store holds none).
 *
 * All calls go through src/client/apiFetch.ts (the #71 rule).
 */
import { apiFetch } from "./apiFetch";
import type { TenantChannelConfig } from "../data/tenantChannelPorts";

export type { TenantChannelConfig };

export const TENANT_CHANNEL_META: Array<{
  id: keyof TenantChannelConfig;
  label: string;
  description: string;
}> = [
  { id: "email", label: "Email", description: "Outbound email delivery for this tenant." },
  { id: "slack", label: "Slack", description: "Slack delivery for this tenant." },
  { id: "webhook", label: "Webhook", description: "Outbound webhook delivery for this tenant." },
  { id: "copilot", label: "Copilot card", description: "Copilot card rendering for this tenant (configuration only — no push dispatch consults this flag yet)." },
  { id: "docs", label: "Docs", description: "Docs delivery for this tenant (configuration only — no push dispatch consults this flag yet)." },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChannels(value: unknown): value is TenantChannelConfig {
  if (!isRecord(value)) return false;
  return (["email", "slack", "webhook", "copilot", "docs"] as const).every(
    (key) => typeof value[key] === "boolean",
  );
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await apiFetch(path, init);
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  return data;
}

export async function fetchTenantChannels(tenantId: string): Promise<TenantChannelConfig> {
  const data = await send<{ channels?: unknown }>(
    `/api/platform-channels/${encodeURIComponent(tenantId)}`,
  );
  if (!isChannels(data.channels)) throw new Error("Unexpected channel config response.");
  return data.channels;
}

export type TenantChannelPatch = Partial<TenantChannelConfig>;

export async function updateTenantChannels(
  tenantId: string,
  patch: TenantChannelPatch,
): Promise<TenantChannelConfig> {
  const data = await send<{ channels?: unknown }>(
    `/api/platform-channels/${encodeURIComponent(tenantId)}/channels`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channels: patch }),
    },
  );
  if (!isChannels(data.channels)) throw new Error("Unexpected channel config response.");
  return data.channels;
}
