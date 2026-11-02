/**
 * @deprecated Superseded by src/client/DataProvidersPanel.tsx (Issue #2723: consolidated into Platform Admin).
 * Issue #2438 (ScreenersHub redesign): the provider connectivity
 * dashboard — the ONE source of truth for provider health (owner
 * decision, #2438 comment 6522933506). Hosted in ScreenersHub;
 * ResearchHub links here, never duplicates it.
 *
 * Stored state only. This surface reads exactly two GET endpoints:
 * GET /api/data-providers (server-computed capture health, E3 view —
 * the panel formats only, every number is server-derived) and
 * GET /api/etrade/oauth/status (signed-in session presence for the
 * E*TRADE row). It NEVER calls Run, Analyze, Scan, Refresh, Verify,
 * or Test & Sync — on load or on poll — and nothing here enqueues,
 * executes, or re-fires a run. Verify and Test & Sync stay explicit,
 * user-initiated, per-provider actions OUTSIDE this dashboard.
 * Refresh rides the hub's hidden-paused polling cadence (60 s).
 *
 * Display rules (copied from the DataProvidersPanel pattern):
 *  - "no-data" renders as Unknown, never as Healthy (a provider with
 *    no captures — e.g. Public before configure → verify → enable —
 *    is unknown, not healthy);
 *  - credential presence is a reference name only, never a value;
 *  - the E*TRADE row shows token presence PER RESOLUTION SCOPE
 *    (login-scoped, unscoped, internal-id, alias-login — presence
 *    only, from oauth/status tokenScopes), so a panel/guard split is
 *    visible here instead of discovered via failed runs. Presence is
 *    not validity: the panel "connected" verdict stays with
 *    oauth/status authenticated.
 */

import { useCallback, useEffect, useState } from "react";
import { usePolling } from "./usePolling";
import { apiFetch as fetch } from "./apiFetch";
import { Badge, Card, EmptyState, Notice, Spinner } from "./components/ui";
import {
  fetchDataProviders,
  fmtCaptureBytes,
  fmtDataProviderTime,
  providerDisplayName,
  type CapabilityRouteView,
  type DataProviderHealthStatus,
  type DataProviderView,
} from "./dataProvidersApi";

interface ETradeScopePresence {
  loginScoped: boolean;
  unscoped: boolean;
  internalId: boolean;
  aliasLogin: boolean;
}

interface ETradeStatus {
  authenticated?: boolean;
  tokenScopes?: ETradeScopePresence;
}

const HEALTH_LABELS: Record<DataProviderHealthStatus, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  down: "Down",
  "no-data": "Unknown",
};

const HEALTH_TONES: Record<DataProviderHealthStatus, "success" | "warning" | "danger" | "neutral"> = {
  healthy: "success",
  degraded: "warning",
  down: "danger",
  "no-data": "neutral",
};

function scopeLines(scopes: ETradeScopePresence): Array<{ scope: string; present: boolean }> {
  return [
    { scope: "login-scoped", present: scopes.loginScoped },
    { scope: "unscoped", present: scopes.unscoped },
    { scope: "internal-id", present: scopes.internalId },
    { scope: "alias-login", present: scopes.aliasLogin },
  ];
}

function isETradeProvider(view: DataProviderView): boolean {
  return view.adapterKind === "etrade" || view.id === "etrade";
}

function routesFor(view: DataProviderView, routes: CapabilityRouteView[]): CapabilityRouteView[] {
  return routes.filter((route) => route.resolvedPrimaryId === view.id || route.resolvedGapFillId === view.id);
}

export function ProviderConnectivityDashboard() {
  const [providers, setProviders] = useState<DataProviderView[]>([]);
  const [routes, setRoutes] = useState<CapabilityRouteView[]>([]);
  const [etradeStatus, setEtradeStatus] = useState<ETradeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await fetchDataProviders();
      setProviders(list.providers);
      setRoutes(list.routes);
      setLoadError(null);
    } catch {
      setLoadError("Provider data could not be loaded.");
    } finally {
      setLoading(false);
    }
    try {
      const res = await fetch("/api/etrade/oauth/status");
      const data = (await res.json().catch(() => null)) as ETradeStatus | null;
      setEtradeStatus(res.ok && data ? data : null);
    } catch {
      setEtradeStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Hub cadence (issue #329 P1, as migrated by #2422): 60 s, paused
  // entirely while the tab is hidden. Reads only — never a probe.
  usePolling(load, { fastMs: 60_000, idleMs: 60_000 });

  return (
    <Card padding="md">
      <h3 style={{ margin: "0 0 0.25rem" }}>Provider connectivity</h3>
      <p style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-muted)", margin: "0 0 1rem" }}>
        Health from stored state only — capture records and credential presence, never a live probe.
        Nothing on this surface runs, verifies, or tests a provider.
      </p>

      {loadError && (
        <Notice tone="danger" density="compact" onDismiss={() => setLoadError(null)}>
          {loadError}
        </Notice>
      )}
      {loading ? (
        <Spinner label="Loading provider health…" />
      ) : providers.length === 0 && !loadError ? (
        <EmptyState title="No providers registered." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          {providers.map((view) => {
            const health = view.health;
            const myRoutes = routesFor(view, routes);
            return (
              <div
                key={view.id}
                data-provider-row={view.id}
                style={{
                  border: "1px solid var(--color-border-subtle)",
                  borderRadius: "8px",
                  padding: "var(--space-3)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700 }}>{providerDisplayName(view)}</span>
                  {health && <Badge tone={HEALTH_TONES[health.status]}>{HEALTH_LABELS[health.status]}</Badge>}
                  <span style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-muted)" }}>
                    {view.lifecycleState}
                    {view.serving ? " · serving" : " · not serving"}
                  </span>
                </div>
                <div style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-muted)", marginTop: "0.25rem" }}>
                  Capabilities: {view.declaredCapabilities.length > 0 ? view.declaredCapabilities.join(", ") : "None declared"}
                  {" · "}Credential: {view.credentialRef ?? "not configured"}
                  {view.verification
                    ? ` · Verified ${fmtDataProviderTime(view.verification.verifiedAt)} by ${view.verification.verifiedBy}`
                    : " · Not verified"}
                </div>
                {health && (
                  <div style={{ fontSize: "var(--font-size-body)", marginTop: "0.25rem" }}>
                    Captures: {health.totalCaptures} · Failure rate: {Math.round(health.failureRate * 100)}% · Last 24h:{" "}
                    {health.capturesLast24h} captures, {health.failuresLast24h} failed · Last success:{" "}
                    {fmtDataProviderTime(health.lastSuccessAt)} · Last failure: {fmtDataProviderTime(health.lastFailureAt)}
                    {health.latestFetchFailureKind ? ` (${health.latestFetchFailureKind})` : ""} · Captured data:{" "}
                    {fmtCaptureBytes(health.totalRawBytes)}
                  </div>
                )}
                {health && Object.keys(health.byCapability ?? {}).length > 0 && (
                  <div style={{ fontSize: "var(--font-size-body)", marginTop: "0.25rem" }}>
                    Per capability:{" "}
                    {Object.entries(health.byCapability)
                      .map(([capability, agg]) => `${capability}: ${agg.totalCaptures} captures (${agg.failedCount} failed)`)
                      .join(" · ")}
                  </div>
                )}
                {myRoutes.length > 0 && (
                  <div style={{ fontSize: "var(--font-size-body)", marginTop: "0.25rem" }}>
                    Routes:{" "}
                    {myRoutes
                      .map((route) => `${route.capability} (${route.resolves ? "resolves" : "unresolved"})`)
                      .join(" · ")}
                  </div>
                )}
                {isETradeProvider(view) && (
                  <div style={{ fontSize: "var(--font-size-body)", marginTop: "0.25rem" }}>
                    {etradeStatus === null ? (
                      <span>E*TRADE session presence unavailable for this session.</span>
                    ) : (
                      <span>
                        Panel (signed-in session): {etradeStatus.authenticated ? "connected" : "not connected"} · Token
                        presence by scope:{" "}
                        {etradeStatus.tokenScopes
                          ? scopeLines(etradeStatus.tokenScopes)
                              .map((line) => `${line.scope}: ${line.present ? "present" : "absent"}`)
                              .join(" · ")
                          : "scope presence unavailable"}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
