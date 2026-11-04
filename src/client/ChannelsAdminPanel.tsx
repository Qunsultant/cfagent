/**
 * Tenant delivery-channel administration panel (issue #3169,
 * program #2218).
 *
 * Operator surface for tenant-level delivery-channel
 * enablement flags (email, Slack, webhook, Copilot card,
 * Docs). Built strictly with src/client/components/ui/
 * primitives and token-only styling per
 * docs/agents/ux-architecture.md §20.
 *
 * Boundaries, stated on the surface so an operator cannot
 * mistake them:
 * - Enablement flags ONLY: this panel never collects a
 *   webhook URL, token, or secret. Secrets stay in worker
 *   bindings; recipients stay per-run / per-schedule.
 * - A disabled channel is refused at dispatch with a typed
 *   error (the tenant channel gate, #3169) — the toggle is
 *   not decorative. Email, Slack, and webhook are enforced
 *   at every dispatch funnel; Copilot card and Docs have no
 *   push dispatch funnel today, so their flags are
 *   configuration only until a funnel exists for them.
 * - A tenant id selected here names an administration target
 *   for an operator (who administers ALL tenants), never the
 *   operator's own scope: scope always derives from the
 *   verified session login, and the server gates every call
 *   on store-operator status (401 / 403 otherwise).
 * - No row means all-enabled: a tenant never configured
 *   behaves exactly as before this slice.
 *
 * All calls go through src/client/apiFetch.ts (the #71 rule),
 * via channelAdminApi.ts and tenantAdminApi.ts.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  EmptyState,
  Notice,
  Spinner,
  Stack,
} from "./components/ui";
import {
  fetchTenantChannels,
  updateTenantChannels,
  TENANT_CHANNEL_META,
  type TenantChannelConfig,
} from "./channelAdminApi";
import { fetchTenants, type TenantListRow } from "./tenantAdminApi";

export function ChannelsAdminPanel() {
  const [tenants, setTenants] = useState<TenantListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [channels, setChannels] = useState<TenantChannelConfig | null>(null);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setTenants(await fetchTenants());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tenants.");
      setTenants([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadChannels = useCallback(async (tenantId: string) => {
    setSelectedId(tenantId);
    setChannelsLoading(true);
    setFormError("");
    try {
      setChannels(await fetchTenantChannels(tenantId));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to load channel config.");
      setChannels(null);
    } finally {
      setChannelsLoading(false);
    }
  }, []);

  const handleToggle = async (key: keyof TenantChannelConfig, enabled: boolean) => {
    if (!selectedId || !channels) return;
    setSaving(true);
    setFormError("");
    try {
      const next = await updateTenantChannels(selectedId, { [key]: enabled });
      setChannels(next);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save channel config.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack gap="2">
      <div className="section-label-row">
        <span>Channels</span>
        <small>Operator-only: enable or disable delivery channels per tenant</small>
      </div>
      <Notice tone="info">
        Enablement flags only — no webhook URLs, tokens, or secrets are collected here. A
        disabled channel is refused at dispatch with a typed error; email, Slack, and webhook
        are enforced at every dispatch funnel. Copilot card and Docs flags are configuration
        only until a push dispatch funnel exists for them.
      </Notice>
      {error && <Notice tone="danger">{error}</Notice>}
      {formError && <Notice tone="danger">{formError}</Notice>}
      {loading ? (
        <Spinner />
      ) : tenants.length === 0 ? (
        <EmptyState title="No tenants yet" description="Create a tenant on the Tenants tab first." />
      ) : (
        <Stack gap="1">
          <div className="section-label-row">
            <span>Select a tenant</span>
          </div>
          {tenants.map((tenant) => (
            <div key={tenant.tenantId}>
              <Button
                size="sm"
                variant={selectedId === tenant.tenantId ? "primary" : "ghost"}
                onClick={() => void loadChannels(tenant.tenantId)}
              >
                {tenant.tenantId}
              </Button>
            </div>
          ))}
        </Stack>
      )}
      {selectedId && channelsLoading && <Spinner />}
      {selectedId && !channelsLoading && channels && (
        <Stack gap="2">
          <div className="section-label-row">
            <span>{selectedId}</span>
            <small>Delivery channels — a tenant with no saved row reads as all-enabled</small>
          </div>
          {TENANT_CHANNEL_META.map((meta) => (
            <div key={meta.id}>
              <Checkbox
                label={meta.label}
                checked={channels[meta.id]}
                disabled={saving}
                onChange={(e) => void handleToggle(meta.id, e.target.checked)}
              />
              <small>{meta.description}</small>
            </div>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
