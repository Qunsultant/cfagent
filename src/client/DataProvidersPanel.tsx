/**
 * Data Providers settings section (issue #1180, consolidated #2723).
 *
 * Tabular admin surface for the data-provider platform: renders the
 * E3 lifecycle API's own view (GET /api/data-providers — configs,
 * verification evidence, declared capabilities, and the registry's
 * servability per capability route) along with consolidated provider
 * connectivity and health metrics from former ProviderConnectivityDashboard.
 *
 * Drives the lifecycle through standard actions:
 *   - Configure
 *   - Verify
 *   - Disable / Enable
 *   - Deprovision
 */

import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Notice, Spinner, TextInput, useToast } from "./components/ui";
import {
  fetchDataProviders,
  fmtCaptureBytes,
  fmtDataProviderTime,
  postDataProviderAction,
  providerDisplayName,
  type CapabilityRouteView,
  type DataProviderActionName,
  type DataProviderHealthStatus,
  type DataProviderView,
} from "./dataProvidersApi";
import "./dataProvidersPanel.css";

const ACTION_PAST: Record<DataProviderActionName, string> = {
  configure: "configured",
  verify: "verified",
  enable: "enabled",
  disable: "disabled",
  deprovision: "deprovisioned",
};

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

/** Plain-language labels for the E6 capture-derived health status. */
const HEALTH_STATUS_LABELS: Record<DataProviderHealthStatus, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  down: "Down",
  "no-data": "No data yet",
};

export function DataProvidersPanel() {
  const toast = useToast();
  const [providers, setProviders] = useState<DataProviderView[]>([]);
  const [routes, setRoutes] = useState<CapabilityRouteView[]>([]);
  const [etradeStatus, setEtradeStatus] = useState<ETradeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [error, setError] = useState("");
  /** Provider id with a POST outstanding — its buttons are disabled. */
  const [actingId, setActingId] = useState<string | null>(null);
  const [confirmingDeprovisionId, setConfirmingDeprovisionId] = useState<string | null>(null);
  const [configuringId, setConfiguringId] = useState<string | null>(null);
  const [configureRef, setConfigureRef] = useState("");
  const [configureName, setConfigureName] = useState("");
  const [registerId, setRegisterId] = useState("");
  const [registerPrecedence, setRegisterPrecedence] = useState("");
  const [registering, setRegistering] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchDataProviders();
      setProviders(data.providers);
      setRoutes(data.routes);
      setNeedsAuth(false);
    } catch (err: any) {
      if (err?.status === 401 || err?.code === "auth_required") {
        setNeedsAuth(true);
        setProviders([]);
        setRoutes([]);
      } else {
        setError(err?.message || "Failed to load data providers.");
        setProviders([]);
        setRoutes([]);
      }
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

  const runAction = async (
    view: DataProviderView,
    action: DataProviderActionName,
    body?: Record<string, unknown>
  ) => {
    setActingId(view.id);
    setError("");
    try {
      await postDataProviderAction(view.id, action, body);
      const past = ACTION_PAST[action] ?? `${action}d`;
      toast.success(`Provider "${view.id}" ${past}.`);
      setConfirmingDeprovisionId(null);
      setConfiguringId(null);
      await load();
    } catch (err: any) {
      setError(err?.message || `Failed to ${action} provider "${view.id}".`);
    } finally {
      setActingId(null);
    }
  };

  const handleConfigureSave = async (view: DataProviderView) => {
    const body: Record<string, unknown> = {
      credentialRef: configureRef.trim(),
    };
    if (configureName.trim()) body.displayName = configureName.trim();
    await runAction(view, "configure", body);
  };

  const handleRegister = async () => {
    const id = registerId.trim();
    if (!id) return;
    setRegistering(true);
    setError("");
    try {
      const body: Record<string, unknown> = {};
      const precedenceText = registerPrecedence.trim();
      if (precedenceText) {
        const precedence = Number.parseInt(precedenceText, 10);
        if (!Number.isNaN(precedence)) body.precedence = precedence;
      }
      await postDataProviderAction(id, "register", body);
      setRegisterId("");
      setRegisterPrecedence("");
      await load();
    } catch (err: any) {
      setError(err?.message || `Failed to register provider "${id}".`);
    } finally {
      setRegistering(false);
    }
  };

  const openConfigure = (view: DataProviderView) => {
    setConfiguringId(view.id);
    setConfigureRef(view.credentialRef ?? "");
    const name = view.config?.displayName;
    setConfigureName(typeof name === "string" ? name : "");
    setConfirmingDeprovisionId(null);
  };

  return (
    <div className="dpp-panel">
      <p className="dpp-desc">
        Market-data providers are provisioned through a unified lifecycle: register, configure a
        credential <em>reference</em> (never the secret itself), verify connectivity, then enable.
        Disabling preserves configuration; deprovisioning withdraws capability routes and clears credentials.
      </p>

      {error && (
        <Notice tone="danger" onDismiss={() => setError("")}>
          {error}
        </Notice>
      )}
      <div style={{ margin: "0 0 0.75rem" }}>
        <Button variant="secondary" size="sm" onClick={() => void load()} loading={loading} disabled={loading}>
          ↻ Refresh
        </Button>
      </div>

      {loading ? (
        <div className="dpp-loading">
          <Spinner size="sm" /> Loading data providers…
        </div>
      ) : needsAuth ? (
        <EmptyState
          title="Sign-in required"
          description="Please log in to view and manage data providers."
        />
      ) : providers.length === 0 ? (
        <EmptyState
          title="No data providers configured"
          description="Register a provider below to start its provisioning lifecycle. Providers appear here with their lifecycle state, verification evidence, and capability routes."
        />
      ) : (
        <div className="dpp-table-container">
          <table className="ui-table dpp-table">
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Lifecycle &amp; State</th>
                <th scope="col">Health &amp; Telemetry</th>
                <th scope="col">Capabilities &amp; Routes</th>
                <th scope="col">Connectivity &amp; Session</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((view) => {
                const busy = actingId === view.id;
                const myRoutes = routes.filter(
                  (r) => r.primaryProviderId === view.id || r.gapFillProviderId === view.id
                );
                return (
                  <tr key={view.id} className="dpp-item" data-provider-id={view.id}>
                    {/* 1. Provider Identity */}
                    <td>
                      <div className="dpp-col-provider">
                        <span className="dpp-item-name">{providerDisplayName(view)}</span>
                        <code className="dpp-item-id">{view.id}</code>
                        <div className="dpp-item-meta">
                          <span>{`Adapter: ${view.adapterKind}`}</span>
                          <span>{`Precedence: ${view.precedence}`}</span>
                        </div>
                      </div>
                    </td>

                    {/* 2. Lifecycle & Access */}
                    <td>
                      <div className="dpp-col-state">
                        <span className="dpp-item-state">{view.lifecycleState}</span>
                        <span className="dpp-item-enabled">{view.enabled ? "Enabled" : "Disabled"}</span>
                        <div className="dpp-item-meta">
                          <span>{`Serving: ${view.serving ? "Yes" : "No"}`}</span>
                          <span>
                            {"Credential reference: "}
                            {view.credentialRef ? <code>{view.credentialRef}</code> : "None"}
                          </span>
                          {view.verification ? (
                            <span>
                              {`Verified ${fmtDataProviderTime(view.verification.verifiedAt)} by ${view.verification.verifiedBy} — ${view.verification.summary}`}
                            </span>
                          ) : (
                            <span>Not verified</span>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* 3. Health & Telemetry */}
                    <td>
                      <div className="dpp-col-health">
                        {view.health ? (
                          <div className="dpp-health">
                            <div className="dpp-health-head">
                              <span className={`dpp-health-status dpp-health-status-${view.health.status}`}>
                                {HEALTH_STATUS_LABELS[view.health.status] ?? view.health.status}
                              </span>
                              <span>{`Captures: ${view.health.totalCaptures}`}</span>
                              <span>{`Failure rate: ${Math.round(view.health.failureRate * 100)}%`}</span>
                              <span>{`Last 24h: ${view.health.capturesLast24h} captures, ${view.health.failuresLast24h} failed`}</span>
                            </div>
                            <div className="dpp-health-meta">
                              <span>{`Last success: ${fmtDataProviderTime(view.health.lastSuccessAt)}`}</span>
                              <span>{`Last failure: ${fmtDataProviderTime(view.health.lastFailureAt)}`}</span>
                              <span>{`Captured data: ${fmtCaptureBytes(view.health.totalRawBytes)}`}</span>
                            </div>
                            {typeof view.health.fetchFailureRate === "number" &&
                              typeof view.health.fetchAttempts === "number" && (
                                <div className="dpp-health-meta">
                                  <span>{`Fetch failure rate: ${Math.round(view.health.fetchFailureRate * 100)}%`}</span>
                                  <span>{`${view.health.fetchFailures ?? 0} of ${view.health.fetchAttempts} attempts failed`}</span>
                                  {view.health.lastFetchFailureAt && (
                                    <span>{`Latest fetch failure: ${fmtDataProviderTime(view.health.lastFetchFailureAt)}${
                                      view.health.latestFetchFailureKind
                                        ? ` (${view.health.latestFetchFailureKind})`
                                        : ""
                                    }`}</span>
                                  )}
                                </div>
                              )}
                            {Object.keys(view.health.byCapability ?? {}).length > 0 && (
                              <ul className="dpp-health-caps">
                                {Object.entries(view.health.byCapability).map(([capability, agg]) => (
                                  <li key={capability} className="dpp-health-cap">
                                    {`${capability}: ${agg.totalCaptures} captures (${agg.failedCount} failed)`}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        ) : (
                          <div className="dpp-health">
                            <span className="dpp-health-status">Health unavailable</span>
                          </div>
                        )}
                      </div>
                    </td>

                    {/* 4. Capabilities & Routes */}
                    <td>
                      <div className="dpp-col-routes">
                        <div className="dpp-item-meta">
                          <span>
                            {`Capabilities: ${
                              view.declaredCapabilities.length > 0
                                ? view.declaredCapabilities.join(", ")
                                : "None declared"
                            }`}
                          </span>
                        </div>
                        {myRoutes.length > 0 && (
                          <ul className="dpp-routes">
                            {myRoutes.map((route) => (
                              <li key={route.capability} className="dpp-route">
                                <span className="dpp-route-capability">{route.capability}</span>
                                <span className="dpp-route-tier">{`Tier: ${route.minTier === "premium" ? "Premium" : "Freemium"}`}</span>
                                <span>{`Primary: ${route.primaryProviderId}`}</span>
                                <span>{`Gap-fill: ${route.gapFillProviderId ?? "—"}`}</span>
                                <span>{`Resolves: ${route.resolves ? "Yes" : "No"}`}</span>
                                {route.error && <span className="dpp-route-error">{route.error}</span>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </td>

                    {/* 5. Connectivity & Session (Consolidated) */}
                    <td>
                      <div className="dpp-col-session">
                        {isETradeProvider(view) ? (
                          <div className="dpp-session-info">
                            {etradeStatus === null ? (
                              <span>E*TRADE session presence unavailable for this session.</span>
                            ) : (
                              <>
                                <span>
                                  <strong>Panel (signed-in session):</strong>{" "}
                                  {etradeStatus.authenticated ? "connected" : "not connected"}
                                </span>
                                <span>
                                  <strong>Token presence by scope:</strong>{" "}
                                  {etradeStatus.tokenScopes
                                    ? scopeLines(etradeStatus.tokenScopes)
                                        .map((line) => `${line.scope}: ${line.present ? "present" : "absent"}`)
                                        .join(" · ")
                                    : "scope presence unavailable"}
                                </span>
                              </>
                            )}
                          </div>
                        ) : (
                          <div className="dpp-session-info">
                            <span>
                              {view.verification ? "Connectivity verified" : "Awaiting verification"}
                            </span>
                            <span>
                              {view.credentialRef ? "Credential reference set" : "No credential configured"}
                            </span>
                          </div>
                        )}
                      </div>
                    </td>

                    {/* 6. Standardized Consistent Actions */}
                    <td>
                      <div className="dpp-col-actions">
                        {confirmingDeprovisionId === view.id ? (
                          <div className="dpp-item-actions">
                            <span className="dpp-confirm-text">
                              Deprovision this provider? Its capability routes are withdrawn and its
                              credential reference is cleared.
                            </span>
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => void runAction(view, "deprovision")}
                              loading={busy}
                              disabled={busy}
                            >
                              Confirm deprovision
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setConfirmingDeprovisionId(null)}
                              disabled={busy}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <div className="dpp-item-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => openConfigure(view)}
                            >
                              Configure
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void runAction(view, "verify")}
                            >
                              Verify
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void runAction(view, view.enabled ? "disable" : "enable")}
                            >
                              {view.enabled ? "Disable" : "Enable"}
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              tone="subtle"
                              disabled={busy}
                              onClick={() => {
                                setConfirmingDeprovisionId(view.id);
                                setConfiguringId(null);
                              }}
                            >
                              Deprovision
                            </Button>
                          </div>
                        )}

                        {configuringId === view.id && (
                          <div className="dpp-configure-form">
                            <TextInput
                              id="dpp-configure-credential-ref"
                              label="Credential reference"
                              placeholder="env:PROVIDER_API_KEY"
                              value={configureRef}
                              onChange={(event) => setConfigureRef(event.target.value)}
                              wrapperClassName="dpp-configure-field"
                            />
                            <TextInput
                              id="dpp-configure-display-name"
                              label="Display name (optional)"
                              placeholder="e.g. Yahoo Finance"
                              value={configureName}
                              onChange={(event) => setConfigureName(event.target.value)}
                              wrapperClassName="dpp-configure-field"
                            />
                            <div className="dpp-configure-actions">
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => void handleConfigureSave(view)}
                                loading={busy}
                                disabled={busy}
                              >
                                Save configuration
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setConfiguringId(null)}
                                disabled={busy}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!needsAuth && (
        <div className="dpp-register-row">
          <TextInput
            id="dpp-register-id"
            label="New provider ID"
            placeholder="e.g. alpaca"
            value={registerId}
            onChange={(event) => setRegisterId(event.target.value)}
            wrapperClassName="dpp-register-field"
          />
          <TextInput
            id="dpp-register-precedence"
            label="Precedence (optional)"
            placeholder="e.g. 3"
            value={registerPrecedence}
            onChange={(event) => setRegisterPrecedence(event.target.value)}
            wrapperClassName="dpp-register-field"
          />
          <Button
            variant="primary"
            onClick={() => void handleRegister()}
            loading={registering}
            disabled={registering || registerId.trim() === ""}
          >
            Register provider
          </Button>
        </div>
      )}
    </div>
  );
}
