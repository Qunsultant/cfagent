/**
 * Data Providers settings section (issue #1180, E4 of epic #1116).
 *
 * The admin surface for the data-provider platform: it renders the
 * E3 lifecycle API's own view (GET /api/data-providers — configs,
 * verification evidence, declared capabilities, and the registry's
 * servability per capability route) and drives the lifecycle through
 * the E3 POST actions (register / configure / verify / enable /
 * disable / deprovision). E3's route layer is the authority: it
 * session-gates mutations, enforces the legal-transition map, and
 * audits every attempt — this panel only offers the moves the map
 * allows from the state the API reports (see providerActions in
 * dataProvidersApi.ts) and surfaces server rejections verbatim.
 *
 * Configure takes a credential REFERENCE name ("env:NAME",
 * "sessionstore:ns:key") — secret values are never entered, sent,
 * or stored here; the server rejects anything that is not a
 * reference name.
 *
 * Honest states: a spinner while loading, the server's error
 * message verbatim on failure, a distinct sign-in-required state on
 * 401, and an explicit empty state — never placeholder rows.
 *
 * E6 (issue #1235): each provider card also renders the health
 * block the API derives from the provider's capture records —
 * status label, capture/failure counts, last success/failure, and
 * captured bytes. The panel formats only; every number and the
 * status itself are computed server-side, and "no-data" (zero
 * captures) renders as its own honest state, never as healthy.
 *
 * E7 (issue #1248): when the API sends the fetch-outcome fields,
 * the card additionally shows the fetch failure rate and the
 * latest fetch failure WITH its classified kind — again formatted
 * only, never derived client-side; an older (v1-shaped) response
 * without those fields renders exactly as before.
 */

import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Notice, Spinner, TextInput, useToast } from "./components/ui";
import {
  fetchDataProviders,
  fmtCaptureBytes,
  fmtDataProviderTime,
  postDataProviderAction,
  providerActions,
  providerDisplayName,
  type CapabilityRouteView,
  type DataProviderActionName,
  type DataProviderHealthStatus,
  type DataProviderView,
} from "./dataProvidersApi";
import "./dataProvidersPanel.css";

const ACTION_LABELS: Record<DataProviderActionName, string> = {
  configure: "Configure",
  verify: "Verify",
  enable: "Enable",
  disable: "Disable",
  deprovision: "Deprovision",
};

/** Past-tense labels for the success toast after an action lands. */
const ACTION_PAST: Record<DataProviderActionName, string> = {
  configure: "configured",
  verify: "verified",
  enable: "enabled",
  disable: "disabled",
  deprovision: "deprovisioned",
};

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
      if (err?.status === 401) {
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
      setConfirmingDeprovisionId(null);
      setConfiguringId(null);
      await load();
      toast.success(`Provider "${view.id}" ${ACTION_PAST[action]}.`);
    } catch (err: any) {
      // Keep the list as-is; the server's message is the explanation.
      setError(err?.message || `Failed to ${action} provider "${view.id}".`);
    } finally {
      setActingId(null);
    }
  };

  const handleConfigureSave = async (view: DataProviderView) => {
    const body: Record<string, unknown> = {};
    const ref = configureRef.trim();
    if (ref) body.credentialRef = ref;
    const name = configureName.trim();
    if (name) body.displayName = name;
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
        Market-data providers are provisioned through a lifecycle: register, configure a
        credential <em>reference</em> (never the secret itself), verify the adapter really
        works, then enable. Disabling keeps the configuration; deprovisioning withdraws the
        provider&apos;s capability routes and clears its credential reference.
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
        <ul className="dpp-list">
          {providers.map((view) => {
            const busy = actingId === view.id;
            const actions = providerActions(view);
            const myRoutes = routes.filter(
              (r) => r.primaryProviderId === view.id || r.gapFillProviderId === view.id
            );
            return (
              <li key={view.id} className="dpp-item" data-provider-id={view.id}>
                <div className="dpp-item-main">
                  <div className="dpp-item-head">
                    <span className="dpp-item-name">{providerDisplayName(view)}</span>
                    <code className="dpp-item-id">{view.id}</code>
                    <span className="dpp-item-state">{view.lifecycleState}</span>
                    <span className="dpp-item-enabled">{view.enabled ? "Enabled" : "Disabled"}</span>
                  </div>
                  <div className="dpp-item-meta">
                    <span>{`Adapter: ${view.adapterKind}`}</span>
                    <span>{`Precedence: ${view.precedence}`}</span>
                    <span>
                      {"Credential reference: "}
                      {view.credentialRef ? <code>{view.credentialRef}</code> : "None"}
                    </span>
                    <span>{`Serving: ${view.serving ? "Yes" : "No"}`}</span>
                    <span>
                      {`Capabilities: ${
                        view.declaredCapabilities.length > 0
                          ? view.declaredCapabilities.join(", ")
                          : "None declared"
                      }`}
                    </span>
                    {view.verification ? (
                      <span>
                        {`Verified ${fmtDataProviderTime(view.verification.verifiedAt)} by ${view.verification.verifiedBy} — ${view.verification.summary}`}
                      </span>
                    ) : (
                      <span>Not verified</span>
                    )}
                  </div>
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
                    {actions.map((action) => (
                      <Button
                        key={action}
                        size="sm"
                        variant={action === "deprovision" ? "danger" : "ghost"}
                        {...(action === "deprovision" ? { tone: "subtle" as const } : {})}
                        disabled={busy}
                        onClick={() => {
                          if (action === "deprovision") {
                            setConfirmingDeprovisionId(view.id);
                            setConfiguringId(null);
                          } else if (action === "configure") {
                            openConfigure(view);
                          } else {
                            void runAction(view, action);
                          }
                        }}
                      >
                        {ACTION_LABELS[action]}
                      </Button>
                    ))}
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
              </li>
            );
          })}
        </ul>
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
