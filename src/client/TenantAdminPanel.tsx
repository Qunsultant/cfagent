/**
 * Tenant administration panel (issue #2221, program #2218 slice 3).
 *
 * Operator surface for tenant create / list / settings, plus a
 * membership VIEW. Built strictly with src/client/components/ui/
 * primitives and token-only styling per docs/agents/ux-architecture.md §20.
 *
 * Boundaries, stated on the surface so an operator cannot mistake
 * them:
 * - Membership changes do NOT live here: the membership table
 *   below is read-only (from the existing IAAA read path, GET
 *   /api/iaaa/memberships filtered by tenant). Grants, revokes,
 *   and edits live on the IAAA Admin tab (CISO lane owns IAAA
 *   writes); this panel never calls a membership mutation.
 * - Tenant identity shown here agrees with the payment screen's
 *   read-only identity by construction: both resolve from the
 *   commercial account row (slice 1, resolvePlatformIdentity).
 *   The payment screen itself stays automatic and read-only —
 *   there is no tenant-id input on it, and editing tenant/user/
 *   account lives here, not there. "Run for free" stays
 *   first-class on the payment path.
 * - A tenant id typed here names an administration target for
 *   an operator (who administers ALL tenants), never the
 *   operator's own scope: scope always derives from the
 *   verified session login, and the server gates every call
 *   on store-operator status (401 / 403 otherwise).
 *
 * All calls go through src/client/apiFetch.ts (the #71 rule),
 * via tenantAdminApi.ts and iaaaAdminApi.ts.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  EmptyState,
  Notice,
  Spinner,
  Stack,
  Table,
  TextInput,
} from "./components/ui";
import {
  createTenant,
  fetchTenantDetail,
  fetchTenants,
  updateTenantSettings,
  type TenantDetail,
  type TenantListRow,
} from "./tenantAdminApi";
import {
  fetchMemberships,
  type AdminMembershipView,
} from "./iaaaAdminApi";

export function TenantAdminPanel() {
  const [tenants, setTenants] = useState<TenantListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [memberships, setMemberships] = useState<AdminMembershipView[]>([]);
  const [newTenantId, setNewTenantId] = useState("");
  const [creating, setCreating] = useState(false);
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

  const loadDetail = useCallback(async (tenantId: string) => {
    setSelectedId(tenantId);
    setDetailLoading(true);
    setFormError("");
    try {
      const [d, all] = await Promise.all([fetchTenantDetail(tenantId), fetchMemberships()]);
      setDetail(d);
      setMemberships(all.filter((m) => m.tenantId === tenantId));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to load tenant detail.");
      setDetail(null);
      setMemberships([]);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleCreate = async () => {
    const tenantId = newTenantId.trim();
    if (!tenantId) {
      setFormError("Enter a tenant id to create.");
      return;
    }
    setCreating(true);
    setFormError("");
    try {
      const created = await createTenant(tenantId);
      setNewTenantId("");
      await load();
      await loadDetail(created.tenantId);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create tenant.");
    } finally {
      setCreating(false);
    }
  };

  const handleSaveSettings = async (patch: {
    adsEnabled?: boolean;
    autoRefresh?: { enabled: boolean; intervalS: number };
    providers?: { dataProviderId: string; brokerId: string };
  }) => {
    if (!detail) return;
    setSaving(true);
    setFormError("");
    try {
      setDetail({ ...detail, ...(await updateTenantSettings(detail.tenantId, patch)) });
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save tenant settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack gap="2">
      <div className="section-label-row">
        <span>Tenants</span>
        <small>Operator-only: create, list, and administer tenant settings</small>
      </div>
      <Notice tone="info">
        Memberships below are read-only. Grants, revokes, and edits live on the IAAA Admin tab.
        Tenant identity here comes from the commercial account row — the same authority the
        payment screen&apos;s read-only identity resolves from.
      </Notice>
      {error && <Notice tone="danger">{error}</Notice>}
      {formError && <Notice tone="danger">{formError}</Notice>}
      <Stack gap="1">
        <TextInput
          label="New tenant id"
          hint="Creates a tenant settings row with store defaults (ads on, auto-refresh off, broker providers)."
          value={newTenantId}
          onChange={(e) => setNewTenantId(e.target.value)}
        />
        <div>
          <Button onClick={() => void handleCreate()} loading={creating} disabled={creating}>
            Create tenant
          </Button>
        </div>
      </Stack>
      {loading ? (
        <Spinner />
      ) : tenants.length === 0 ? (
        <EmptyState title="No tenants yet" description="Create the first tenant above, or wait for account rows to appear." />
      ) : (
        <Table<TenantListRow>
          caption="Tenants"
          columns={[
            { key: "tenantId", header: "Tenant", render: (row) => row.tenantId },
            { key: "members", header: "Account members", render: (row) => String(row.memberCount) },
            { key: "ads", header: "Ads", render: (row) => (row.adsEnabled ? "On" : "Off") },
            { key: "providers", header: "Data provider / broker", render: (row) => `${row.dataProviderId} / ${row.brokerId}` },
            {
              key: "open",
              header: "",
              render: (row) => (
                <Button size="sm" onClick={() => void loadDetail(row.tenantId)}>
                  Manage
                </Button>
              ),
            },
          ]}
          rows={tenants}
          rowKey={(row) => row.tenantId}
        />
      )}
      {selectedId && detailLoading && <Spinner />}
      {selectedId && !detailLoading && detail && (
        <Stack gap="2">
          <div className="section-label-row">
            <span>{detail.tenantId}</span>
            <small>Tenant settings and members</small>
          </div>
          <Checkbox
            label="Ads enabled for this tenant"
            checked={detail.adsEnabled}
            disabled={saving}
            onChange={(e) => void handleSaveSettings({ adsEnabled: e.target.checked })}
          />
          <Checkbox
            label="Auto-refresh enabled"
            checked={detail.autoRefreshEnabled}
            disabled={saving}
            onChange={(e) =>
              void handleSaveSettings({
                autoRefresh: { enabled: e.target.checked, intervalS: detail.autoRefreshIntervalS },
              })
            }
          />
          <TextInput
            label="Auto-refresh interval (seconds)"
            type="number"
            value={String(detail.autoRefreshIntervalS)}
            disabled={saving}
            onBlur={(e) => {
              const intervalS = Number.parseInt(e.currentTarget.value, 10);
              if (Number.isInteger(intervalS) && intervalS > 0) {
                void handleSaveSettings({
                  autoRefresh: { enabled: detail.autoRefreshEnabled, intervalS },
                });
              }
            }}
          />
          <TextInput
            label="Data provider id"
            value={detail.dataProviderId}
            disabled={saving}
            onBlur={(e) => {
              if (e.currentTarget.value) {
                void handleSaveSettings({
                  providers: { dataProviderId: e.currentTarget.value, brokerId: detail.brokerId },
                });
              }
            }}
          />
          <TextInput
            label="Broker id"
            value={detail.brokerId}
            disabled={saving}
            onBlur={(e) => {
              if (e.currentTarget.value) {
                void handleSaveSettings({
                  providers: { dataProviderId: detail.dataProviderId, brokerId: e.currentTarget.value },
                });
              }
            }}
          />
          <div className="section-label-row">
            <span>Account members</span>
            <small>From commercial account rows — the payment-screen identity authority</small>
          </div>
          {detail.members.length === 0 ? (
            <EmptyState title="No account members" description="This tenant has a settings row but no commercial account rows yet." />
          ) : (
            <Table
              caption="Account members"
              columns={[
                { key: "userId", header: "User", render: (row) => row.userId },
                { key: "tier", header: "Tier", render: (row) => row.tier },
                { key: "credits", header: "Credits (USD)", render: (row) => row.creditsUSD.toFixed(2) },
                { key: "runs", header: "Included runs", render: (row) => String(row.includedRuns) },
              ]}
              rows={detail.members}
              rowKey={(row) => row.userId}
            />
          )}
          <div className="section-label-row">
            <span>IAAA memberships (read-only)</span>
            <small>From the IAAA read path; changes live on the IAAA Admin tab</small>
          </div>
          {memberships.length === 0 ? (
            <EmptyState title="No IAAA memberships" description="No membership records exist for this tenant." />
          ) : (
            <Table<AdminMembershipView>
              caption="IAAA memberships"
              columns={[
                { key: "user", header: "Internal user", render: (row) => row.internalUserId },
                {
                  key: "roles",
                  header: "Roles",
                  render: (row) => row.roleBindings.map((b) => `${b.role} (${b.scope})`).join(", "),
                },
                { key: "revoked", header: "Revoked", render: (row) => (row.revokedAtMs ? "Yes" : "No") },
              ]}
              rows={memberships}
              rowKey={(row) => row.membershipId}
            />
          )}
        </Stack>
      )}
    </Stack>
  );
}
