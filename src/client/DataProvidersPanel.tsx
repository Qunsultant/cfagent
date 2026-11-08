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
import { Button, EmptyState, Notice, Spinner, Table, type TableColumn, TextInput, useToast } from "./components/ui";
import {
  fetchDataProviders,
  fmtCaptureBytes,
  fmtDataProviderTime,
  fmtFeedAge,
  postDataProviderAction,
  postAnalyzeJobAction,
  postDeliverJobAction,
  postEnrichJobAction,
  postFeedJobAction,
  postFeedJobSchedule,
  postFeedRun,
  postGenerateJobAction,
  postPipelineChainAction,
  providerDisplayName,
  type AnalyzeJobActionName,
  type AnalyzeJobView,
  type CapabilityRouteView,
  type DataProviderActionName,
  type DataProviderHealthStatus,
  type DataProviderView,
  type DeliverJobActionName,
  type DeliverJobView,
  type PipelineChainActionName,
  type PipelineChainView,
  type EnrichJobActionName,
  type EnrichJobView,
  type FeedDatasetStatusView,
  type FeedJobActionName,
  type FeedJobView,
  type GenerateJobActionName,
  type GenerateJobView,
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

/**
 * The display state of the #3530 feed-status block, derived ONLY
 * from the served block (never recomputed): not-configured,
 * never-run, last-run-failed, stale, and ready are five distinct
 * states and render five distinct chips.
 */
function feedStatusChip(feed: FeedDatasetStatusView): { text: string; tone: string } {
  if (feed.state === "not-configured") return { text: "Not configured", tone: "not-configured" };
  if (feed.state === "never-run") return { text: "Never run", tone: "never-run" };
  if (feed.lastRun?.status === "failed") return { text: "Last run failed", tone: "failed" };
  if (feed.snapshot?.stale) return { text: "Stale", tone: "stale" };
  return { text: "Ready", tone: "ready" };
}

/**
 * One provider's direct feed-job status (#3530): the job's last
 * run (time, trigger, outcome — a failed run shows its stable
 * code and message, never a success dressing), the persisted
 * local copy's state (rows, age, as-of provenance, STALE marker;
 * "none usable" when runs exist but no good copy does), and the
 * dataset facts the API exposes (universe, cadence, stale-after).
 * This is a different fact from the capture-derived health column
 * and from the #3535 pipeline blocks below it: it is the dataset
 * store's own record, and it still renders when the pipeline host
 * is unreachable (its list is best-effort and may be empty).
 */
function FeedStatusBlock({
  feed,
  busy,
  onRunNow,
}: {
  feed: FeedDatasetStatusView;
  busy: boolean;
  onRunNow: () => void;
}) {
  const chip = feedStatusChip(feed);
  const lastRun = feed.lastRun;
  const snapshot = feed.snapshot;
  return (
    <div className="dpp-feed-status" data-feed-job={feed.jobId}>
      <div className="dpp-feed-head">
        <span className="dpp-feed-label">{feed.jobId}</span>
        <span className={`dpp-feed-status-chip dpp-feed-status-chip-${chip.tone}`}>{chip.text}</span>
      </div>
      <div className="dpp-feed-meta">
        <span>{`Universe: ${feed.universeLabel}`}</span>
        <span>{`Cadence: every ${feed.cadenceMinutes}m · stale after ${feed.staleAfterMinutes}m`}</span>
        {feed.state === "not-configured" && (
          <span>Feed status unavailable: no dataset store is wired on this host.</span>
        )}
        {feed.state === "never-run" && <span>Never run — no local copy yet.</span>}
        {feed.state === "ready" && lastRun && (
          <span>
            {`Last run: ${lastRun.status} · ${lastRun.trigger} · ${fmtDataProviderTime(lastRun.finishedAt)} · ${lastRun.received}/${lastRun.requested} rows`}
          </span>
        )}
        {feed.state === "ready" && lastRun?.codedError && (
          <span className="dpp-feed-error">{lastRun.codedError}</span>
        )}
        {feed.state === "ready" && lastRun?.errorMessage && <span>{lastRun.errorMessage}</span>}
        {feed.state === "ready" &&
          (snapshot ? (
            <span>
              {`Local copy: ${snapshot.rowsPersisted} rows · ${fmtFeedAge(snapshot.ageSeconds)} · as of ${fmtDataProviderTime(snapshot.asOf)}${snapshot.stale ? " · STALE" : ""}`}
            </span>
          ) : (
            <span>Local copy: none usable</span>
          ))}
      </div>
      {feed.state !== "not-configured" && (
        <div className="dpp-feed-actions">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onRunNow}>
            Run now
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * One feed job's stored-schedule editor (#3530 scheduling-config):
 * renders the schedule the API serves on the job's surface view —
 * the STORED pipeline definition's schedule, the configuration
 * that actually schedules the job — and posts changes to the
 * schedule route. A job whose view carries no schedule renders
 * "Schedule: unknown" with no controls: an honest unknown, never
 * a cadence fabricated from the registry default.
 */
function FeedJobScheduleEditor({
  view,
  job,
  busy,
  onSave,
}: {
  view: DataProviderView;
  job: FeedJobView;
  busy: boolean;
  onSave: (
    view: DataProviderView,
    job: FeedJobView,
    patch: { enabled?: boolean; intervalMinutes?: number }
  ) => void;
}) {
  const schedule = job.schedule ?? null;
  const minutesOf = (interval: string | null): string => {
    const match = interval?.match(/^every (\d+) minutes$/);
    return match ? match[1]! : "";
  };
  const [minutes, setMinutes] = useState<string>(() => minutesOf(schedule?.interval ?? null));
  useEffect(() => {
    setMinutes(minutesOf(schedule?.interval ?? null));
  }, [schedule?.interval]);
  if (!schedule) {
    return (
      <div className="dpp-feed-meta">
        <span>Schedule: unknown</span>
      </div>
    );
  }
  const label = !schedule.enabled
    ? "Schedule: off"
    : schedule.cron
      ? `Schedule: cron ${schedule.cron}`
      : schedule.interval
        ? `Schedule: ${schedule.interval}`
        : "Schedule: on";
  const parsed = Number.parseInt(minutes, 10);
  const canSave = Number.isInteger(parsed) && parsed > 0;
  return (
    <div className="dpp-feed-schedule">
      <div className="dpp-feed-meta">
        <span>{label}</span>
      </div>
      <div className="dpp-feed-actions">
        <TextInput
          size="sm"
          type="number"
          min={1}
          step={1}
          value={minutes}
          disabled={busy || !schedule.enabled}
          data-feed-schedule-minutes={job.jobId}
          aria-label={`Cadence in minutes for ${job.jobId}`}
          onChange={(event) => setMinutes(event.target.value)}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !canSave}
          onClick={() => onSave(view, job, { enabled: schedule.enabled, intervalMinutes: parsed })}
        >
          Save schedule
        </Button>
        {schedule.enabled ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onSave(view, job, { enabled: false })}
          >
            Disable schedule
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onSave(view, job, { enabled: true })}
          >
            Enable schedule
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The honest no-job state (#3530): the provider has no registered
 * feed job. Nasdaq's carries the recorded reason — its adapter
 * serves the US listed-securities universe, not quotes, so the
 * quotes-shaped feed contract cannot express its dataset; no job
 * is registered rather than a fabricated one.
 */
function FeedNoJobBlock({ providerId }: { providerId: string }) {
  return (
    <div className="dpp-feed-nojob">
      <span className="dpp-feed-none">No feed job for this source</span>
      {providerId === "nasdaq" && (
        <span className="dpp-feed-nojob-note">
          Its adapter serves the US listed-securities universe, not quotes, so it does not fit the
          quotes feed-job contract — no feed job is registered for it rather than a fabricated one
          (issue 3530).
        </span>
      )}
    </div>
  );
}

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

  // #3535: run / manage one of the provider's feed jobs through
  // the pipeline host, then reload so the merged status view the
  // server computed is what renders (one source of truth).
  const runFeedAction = async (
    view: DataProviderView,
    job: FeedJobView,
    action: FeedJobActionName
  ) => {
    setActingId(view.id);
    setError("");
    try {
      await postFeedJobAction(view.id, job.jobId, action);
      toast.success(`Feed job "${job.jobId}" ${action} dispatched.`);
      await load();
    } catch (err: any) {
      setError(err?.message || `Failed to ${action} feed job "${job.jobId}".`);
    } finally {
      setActingId(null);
    }
  };

  // #3530 (scheduling-config): save one feed job's schedule patch
  // through the schedule route, then reload so the block re-renders
  // from the server's stored definition (one source of truth). A
  // refusal surfaces the server's own message in the error Notice,
  // exactly like every other panel action.
  const saveFeedSchedule = async (
    view: DataProviderView,
    job: FeedJobView,
    patch: { enabled?: boolean; intervalMinutes?: number }
  ) => {
    setActingId(view.id);
    setError("");
    try {
      await postFeedJobSchedule(view.id, job.jobId, patch);
      toast.success(`Feed job "${job.jobId}" schedule saved.`);
      await load();
    } catch (err: any) {
      setError(err?.message || `Failed to save the schedule for feed job "${job.jobId}".`);
    } finally {
      setActingId(null);
    }
  };

  // #3536: run / manage one of the provider's enrich jobs
  // through the pipeline host — the feed action's shape, one
  // stage later (the run consumes the persisted feed copy).
  const runEnrichAction = async (
    view: DataProviderView,
    job: EnrichJobView,
    action: EnrichJobActionName
  ) => {
    setActingId(view.id);
    setError("");
    try {
      await postEnrichJobAction(view.id, job.jobId, action);
      toast.success(`Enrich job "${job.jobId}" ${action} dispatched.`);
      await load();
    } catch (err: any) {
      setError(err?.message || `Failed to ${action} enrich job "${job.jobId}".`);
    } finally {
      setActingId(null);
    }
  };

  // #3530 (status UX): run the provider's feed job now through the
  // S1 feed-run route (a pipeline-door dispatch since #3578), then
  // reload so the status block
  // re-renders from the server's fresh status (one source of
  // truth). The run's outcome is surfaced as it came back: the
  // route answers 200 even for a failed run, so a failed outcome
  // lands in the persistent error Notice with its stable code —
  // never as a success toast; a partial run is a warning. HTTP
  // refusals (session / not-configured) surface the server's own
  // error verbatim, like every other panel action.
  const runFeedNow = async (view: DataProviderView) => {
    setActingId(view.id);
    setError("");
    try {
      const { run } = await postFeedRun(view.id);
      if (run.status === "failed") {
        setError(
          `Feed job "${run.jobId}" run failed${run.codedError ? ` (${run.codedError})` : ""}: ${run.received}/${run.requested} rows received.`
        );
      } else if (run.status === "partial") {
        toast.warning(
          `Feed job "${run.jobId}" run partially completed (${run.received}/${run.requested} rows).`
        );
      } else {
        toast.success(`Feed job "${run.jobId}" run completed (${run.received}/${run.requested} rows).`);
      }
      await load();
    } catch (err: any) {
      setError(err?.message || `Failed to run the feed job for "${view.id}".`);
    } finally {
      setActingId(null);
    }
  };

  // #3537: run / manage one of the provider's analyze jobs
  // through the pipeline host — the enrich action's shape, one
  // stage later (the run consumes the persisted enriched copy).
  const runAnalyzeAction = async (
    view: DataProviderView,
    job: AnalyzeJobView,
    action: AnalyzeJobActionName
  ) => {
    setActingId(view.id);
    setError("");
    try {
      await postAnalyzeJobAction(view.id, job.jobId, action);
      toast.success(`Analyze job "${job.jobId}" ${action} dispatched.`);
      await load();
    } catch (err: any) {
      setError(err?.message || `Failed to ${action} analyze job "${job.jobId}".`);
    } finally {
      setActingId(null);
    }
  };

  // #3538: run / manage one of the provider's generate jobs
  // through the pipeline host — the analyze action's shape, one
  // stage later (the run consumes the persisted analyzed copy).
  const runGenerateAction = async (
    view: DataProviderView,
    job: GenerateJobView,
    action: GenerateJobActionName
  ) => {
    setActingId(view.id);
    setError("");
    try {
      await postGenerateJobAction(view.id, job.jobId, action);
      toast.success(`Generate job "${job.jobId}" ${action} dispatched.`);
      await load();
    } catch (err: any) {
      setError(err?.message || `Failed to ${action} generate job "${job.jobId}".`);
    } finally {
      setActingId(null);
    }
  };

  // #3539: run / manage one of the provider's deliver jobs
  // through the pipeline host — the generate action's shape, one
  // stage later (the run consumes the persisted generated copy).
  const runDeliverAction = async (
    view: DataProviderView,
    job: DeliverJobView,
    action: DeliverJobActionName
  ) => {
    setActingId(view.id);
    setError("");
    try {
      await postDeliverJobAction(view.id, job.jobId, action);
      toast.success(`Deliver job "${job.jobId}" ${action} dispatched.`);
      await load();
    } catch (err: any) {
      setError(err?.message || `Failed to ${action} deliver job "${job.jobId}".`);
    } finally {
      setActingId(null);
    }
  };

  // #3540: run / manage one of the provider's composed pipeline
  // chains (or one stage inside its run) through the pipeline
  // host — the deliver action's shape, transposed to the
  // composition.
  const runChainAction = async (
    view: DataProviderView,
    chain: PipelineChainView,
    action: PipelineChainActionName,
    stage?: string
  ) => {
    setActingId(view.id);
    setError("");
    try {
      await postPipelineChainAction(view.id, chain.jobId, action, stage);
      toast.success(
        `Pipeline chain "${chain.jobId}" ${action}${stage ? ` (${stage})` : ""} dispatched.`
      );
      await load();
    } catch (err: any) {
      setError(err?.message || `Failed to ${action} pipeline chain "${chain.jobId}".`);
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
        <Table<DataProviderView>
          columns={[
            {
              key: "provider",
              header: "Provider",
              cellClassName: "dpp-col-provider-cell",
              render: (view) => (
                <div className="dpp-col-provider">
                  <span className="dpp-item-name">{providerDisplayName(view)}</span>
                  <code className="dpp-item-id">{view.id}</code>
                  <div className="dpp-item-meta">
                    <span>{`Adapter: ${view.adapterKind}`}</span>
                    <span>{`Precedence: ${view.precedence}`}</span>
                  </div>
                </div>
              ),
            },
            {
              key: "state",
              header: "Lifecycle & State",
              cellClassName: "dpp-col-state-cell",
              render: (view) => (
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
              ),
            },
            {
              key: "health",
              header: "Health & Telemetry",
              cellClassName: "dpp-col-health-cell",
              render: (view) => (
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
                    <span className="dpp-health-nodata">Health unavailable</span>
                  )}
                </div>
              ),
            },
            {
              key: "feedJobs",
              header: "Feed Jobs",
              cellClassName: "dpp-col-feed-cell",
              render: (view) => {
                const feed = view.feed ?? null;
                const jobs = view.feedJobs ?? [];
                if (!feed && jobs.length === 0) {
                  return <FeedNoJobBlock providerId={view.id} />;
                }
                const busy = actingId === view.id;
                return (
                  <div className="dpp-feed-jobs">
                    {feed && (
                      <FeedStatusBlock
                        feed={feed}
                        busy={busy}
                        onRunNow={() => void runFeedNow(view)}
                      />
                    )}
                    {jobs.map((job) => {
                      const state = job.pipeline?.state ?? "unknown";
                      const lastRun = job.feed?.lastRun ?? null;
                      const snapshot = job.feed?.snapshot ?? null;
                      const ageLabel = snapshot
                        ? snapshot.ageSeconds < 90
                          ? `${snapshot.ageSeconds}s old`
                          : snapshot.ageSeconds < 5400
                            ? `${Math.round(snapshot.ageSeconds / 60)}m old`
                            : `${(snapshot.ageSeconds / 3600).toFixed(1)}h old`
                        : null;
                      return (
                        <div key={job.jobId} className="dpp-feed-job">
                          <div className="dpp-feed-head">
                            <span className="dpp-feed-label">{job.label}</span>
                            <span className={`dpp-feed-state dpp-feed-state-${state}`}>
                              {state}
                            </span>
                          </div>
                          <div className="dpp-feed-meta">
                            {job.feed?.state === "never-run" || !lastRun ? (
                              <span>Never run</span>
                            ) : (
                              <span>
                                {`Last run: ${lastRun.status} ${fmtDataProviderTime(lastRun.finishedAt)} (${lastRun.received}/${lastRun.requested} rows)`}
                              </span>
                            )}
                            {snapshot && (
                              <span>
                                {`Persisted: ${snapshot.rowsPersisted} rows · ${ageLabel}${snapshot.stale ? " · STALE" : ""}`}
                              </span>
                            )}
                            {job.nextScheduledRun && (
                              <span>{`Next run: ${fmtDataProviderTime(job.nextScheduledRun)}`}</span>
                            )}
                            {lastRun?.codedError && (
                              <span className="dpp-feed-error">{lastRun.codedError}</span>
                            )}
                          </div>
                          {(job.feed?.history?.length ?? 0) > 1 && (
                            <ul className="dpp-feed-history">
                              {job.feed!.history.slice(1, 4).map((run) => (
                                <li key={run.runId}>
                                  {`${run.status} · ${fmtDataProviderTime(run.finishedAt)} · ${run.received}/${run.requested} rows`}
                                </li>
                              ))}
                            </ul>
                          )}
                          <div className="dpp-feed-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void runFeedAction(view, job, "run")}
                            >
                              Run
                            </Button>
                            {(state === "running" || state === "queued") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runFeedAction(view, job, "pause")}
                              >
                                Pause
                              </Button>
                            )}
                            {state === "paused" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runFeedAction(view, job, "resume")}
                              >
                                Resume
                              </Button>
                            )}
                            {(state === "running" || state === "queued" || state === "paused") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runFeedAction(view, job, "cancel")}
                              >
                                Cancel
                              </Button>
                            )}
                            {(state === "completed" || state === "failed" || state === "cancelled") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runFeedAction(view, job, "retry")}
                              >
                                Retry
                              </Button>
                            )}
                          </div>
                          <FeedJobScheduleEditor view={view} job={job} busy={busy} onSave={saveFeedSchedule} />
                        </div>
                      );
                    })}
                  </div>
                );
              },
            },
            {
              // #3536: the enrich jobs column — the feed-jobs
              // column's shape transposed (same dpp-feed-*
              // classes; no new stylesheet), plus the lineage
              // line naming the feed run each copy derives from.
              key: "enrichJobs",
              header: "Enrich Jobs",
              cellClassName: "dpp-col-feed-cell",
              render: (view) => {
                const jobs = view.enrichJobs ?? [];
                if (jobs.length === 0) {
                  return <span className="dpp-feed-none">No enrich jobs</span>;
                }
                const busy = actingId === view.id;
                return (
                  <div className="dpp-feed-jobs">
                    {jobs.map((job) => {
                      const state = job.pipeline?.state ?? "unknown";
                      const lastRun = job.enrich?.lastRun ?? null;
                      const snapshot = job.enrich?.snapshot ?? null;
                      const ageLabel = snapshot
                        ? snapshot.ageSeconds < 90
                          ? `${snapshot.ageSeconds}s old`
                          : snapshot.ageSeconds < 5400
                            ? `${Math.round(snapshot.ageSeconds / 60)}m old`
                            : `${(snapshot.ageSeconds / 3600).toFixed(1)}h old`
                        : null;
                      return (
                        <div key={job.jobId} className="dpp-feed-job">
                          <div className="dpp-feed-head">
                            <span className="dpp-feed-label">{job.label}</span>
                            <span className={`dpp-feed-state dpp-feed-state-${state}`}>
                              {state}
                            </span>
                          </div>
                          <div className="dpp-feed-meta">
                            {job.enrich?.state === "never-run" || !lastRun ? (
                              <span>Never run</span>
                            ) : (
                              <span>
                                {`Last run: ${lastRun.status} ${fmtDataProviderTime(lastRun.finishedAt)} (${lastRun.received}/${lastRun.requested} rows)`}
                              </span>
                            )}
                            {snapshot && (
                              <span>
                                {`Enriched: ${snapshot.rowsPersisted} rows · ${ageLabel}${snapshot.stale ? " · STALE" : ""}`}
                              </span>
                            )}
                            {snapshot?.inputRunId && (
                              <span>{`Derived from feed run: ${snapshot.inputRunId}`}</span>
                            )}
                            {job.nextScheduledRun && (
                              <span>{`Next run: ${fmtDataProviderTime(job.nextScheduledRun)}`}</span>
                            )}
                            {lastRun?.codedError && (
                              <span className="dpp-feed-error">{lastRun.codedError}</span>
                            )}
                          </div>
                          {(job.enrich?.history?.length ?? 0) > 1 && (
                            <ul className="dpp-feed-history">
                              {job.enrich!.history.slice(1, 4).map((run) => (
                                <li key={run.runId}>
                                  {`${run.status} · ${fmtDataProviderTime(run.finishedAt)} · ${run.received}/${run.requested} rows`}
                                </li>
                              ))}
                            </ul>
                          )}
                          <div className="dpp-feed-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void runEnrichAction(view, job, "run")}
                            >
                              Run
                            </Button>
                            {(state === "running" || state === "queued") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runEnrichAction(view, job, "pause")}
                              >
                                Pause
                              </Button>
                            )}
                            {state === "paused" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runEnrichAction(view, job, "resume")}
                              >
                                Resume
                              </Button>
                            )}
                            {(state === "running" || state === "queued" || state === "paused") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runEnrichAction(view, job, "cancel")}
                              >
                                Cancel
                              </Button>
                            )}
                            {(state === "completed" || state === "failed" || state === "cancelled") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runEnrichAction(view, job, "retry")}
                              >
                                Retry
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              },
            },
            {
              // #3537: the analyze jobs column — the enrich-jobs
              // column's shape transposed (same dpp-feed-*
              // classes; no new stylesheet), plus the lineage
              // line naming the enrich run each copy derives from
              // and the breadth line from the analyzed summary.
              key: "analyzeJobs",
              header: "Analyze Jobs",
              cellClassName: "dpp-col-feed-cell",
              render: (view) => {
                const jobs = view.analyzeJobs ?? [];
                if (jobs.length === 0) {
                  return <span className="dpp-feed-none">No analyze jobs</span>;
                }
                const busy = actingId === view.id;
                return (
                  <div className="dpp-feed-jobs">
                    {jobs.map((job) => {
                      const state = job.pipeline?.state ?? "unknown";
                      const lastRun = job.analyze?.lastRun ?? null;
                      const snapshot = job.analyze?.snapshot ?? null;
                      const ageLabel = snapshot
                        ? snapshot.ageSeconds < 90
                          ? `${snapshot.ageSeconds}s old`
                          : snapshot.ageSeconds < 5400
                            ? `${Math.round(snapshot.ageSeconds / 60)}m old`
                            : `${(snapshot.ageSeconds / 3600).toFixed(1)}h old`
                        : null;
                      return (
                        <div key={job.jobId} className="dpp-feed-job">
                          <div className="dpp-feed-head">
                            <span className="dpp-feed-label">{job.label}</span>
                            <span className={`dpp-feed-state dpp-feed-state-${state}`}>
                              {state}
                            </span>
                          </div>
                          <div className="dpp-feed-meta">
                            {job.analyze?.state === "never-run" || !lastRun ? (
                              <span>Never run</span>
                            ) : (
                              <span>
                                {`Last run: ${lastRun.status} ${fmtDataProviderTime(lastRun.finishedAt)} (${lastRun.received}/${lastRun.requested} rows)`}
                              </span>
                            )}
                            {snapshot && (
                              <span>
                                {`Analyzed: ${snapshot.rowsPersisted} rows · ${ageLabel}${snapshot.stale ? " · STALE" : ""}`}
                              </span>
                            )}
                            {snapshot && (
                              <span>
                                {`Breadth: ${snapshot.summary.advancers} up / ${snapshot.summary.decliners} down${snapshot.summary.meanCompositeScore !== null ? ` · mean composite ${snapshot.summary.meanCompositeScore}` : ""}`}
                              </span>
                            )}
                            {snapshot?.inputRunId && (
                              <span>{`Derived from enrich run: ${snapshot.inputRunId}`}</span>
                            )}
                            {job.nextScheduledRun && (
                              <span>{`Next run: ${fmtDataProviderTime(job.nextScheduledRun)}`}</span>
                            )}
                            {lastRun?.codedError && (
                              <span className="dpp-feed-error">{lastRun.codedError}</span>
                            )}
                          </div>
                          {(job.analyze?.history?.length ?? 0) > 1 && (
                            <ul className="dpp-feed-history">
                              {job.analyze!.history.slice(1, 4).map((run) => (
                                <li key={run.runId}>
                                  {`${run.status} · ${fmtDataProviderTime(run.finishedAt)} · ${run.received}/${run.requested} rows`}
                                </li>
                              ))}
                            </ul>
                          )}
                          <div className="dpp-feed-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void runAnalyzeAction(view, job, "run")}
                            >
                              Run
                            </Button>
                            {(state === "running" || state === "queued") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runAnalyzeAction(view, job, "pause")}
                              >
                                Pause
                              </Button>
                            )}
                            {state === "paused" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runAnalyzeAction(view, job, "resume")}
                              >
                                Resume
                              </Button>
                            )}
                            {(state === "running" || state === "queued" || state === "paused") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runAnalyzeAction(view, job, "cancel")}
                              >
                                Cancel
                              </Button>
                            )}
                            {(state === "completed" || state === "failed" || state === "cancelled") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runAnalyzeAction(view, job, "retry")}
                              >
                                Retry
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              },
            },
            {
              // #3538: the generate jobs column — the analyze-jobs
              // column's shape transposed (same dpp-feed-*
              // classes; no new stylesheet), plus the per-report
              // formats line and the canonical leg's outcome from
              // the generated copy.
              key: "generateJobs",
              header: "Generate Jobs",
              cellClassName: "dpp-col-feed-cell",
              render: (view) => {
                const jobs = view.generateJobs ?? [];
                if (jobs.length === 0) {
                  return <span className="dpp-feed-none">No generate jobs</span>;
                }
                const busy = actingId === view.id;
                return (
                  <div className="dpp-feed-jobs">
                    {jobs.map((job) => {
                      const state = job.pipeline?.state ?? "unknown";
                      const lastRun = job.generate?.lastRun ?? null;
                      const snapshot = job.generate?.snapshot ?? null;
                      const ageLabel = snapshot
                        ? snapshot.ageSeconds < 90
                          ? `${snapshot.ageSeconds}s old`
                          : snapshot.ageSeconds < 5400
                            ? `${Math.round(snapshot.ageSeconds / 60)}m old`
                            : `${(snapshot.ageSeconds / 3600).toFixed(1)}h old`
                        : null;
                      return (
                        <div key={job.jobId} className="dpp-feed-job">
                          <div className="dpp-feed-head">
                            <span className="dpp-feed-label">{job.label}</span>
                            <span className={`dpp-feed-state dpp-feed-state-${state}`}>
                              {state}
                            </span>
                          </div>
                          <div className="dpp-feed-meta">
                            {job.generate?.state === "never-run" || !lastRun ? (
                              <span>Never run</span>
                            ) : (
                              <span>
                                {`Last run: ${lastRun.status} ${fmtDataProviderTime(lastRun.finishedAt)} (${lastRun.received}/${lastRun.requested} formats)`}
                              </span>
                            )}
                            {snapshot && (
                              <span>
                                {`Generated: ${snapshot.reportsPersisted} reports · ${snapshot.formatsPersisted} formats · ${ageLabel}${snapshot.stale ? " · STALE" : ""}`}
                              </span>
                            )}
                            {snapshot?.reports.map((report) => (
                              <span key={report.kind}>
                                {`${report.kind}: ${report.formatsGenerated.join(", ") || "none"}${report.formatsFailed.length > 0 ? ` · failed: ${report.formatsFailed.join(", ")}` : ""} · canonical: ${report.canonicalStatus}`}
                              </span>
                            ))}
                            {snapshot?.inputRunId && (
                              <span>{`Derived from analyze run: ${snapshot.inputRunId}`}</span>
                            )}
                            {job.nextScheduledRun && (
                              <span>{`Next run: ${fmtDataProviderTime(job.nextScheduledRun)}`}</span>
                            )}
                            {lastRun?.codedError && (
                              <span className="dpp-feed-error">{lastRun.codedError}</span>
                            )}
                          </div>
                          {(job.generate?.history?.length ?? 0) > 1 && (
                            <ul className="dpp-feed-history">
                              {job.generate!.history.slice(1, 4).map((run) => (
                                <li key={run.runId}>
                                  {`${run.status} · ${fmtDataProviderTime(run.finishedAt)} · ${run.received}/${run.requested} formats`}
                                </li>
                              ))}
                            </ul>
                          )}
                          <div className="dpp-feed-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void runGenerateAction(view, job, "run")}
                            >
                              Run
                            </Button>
                            {(state === "running" || state === "queued") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runGenerateAction(view, job, "pause")}
                              >
                                Pause
                              </Button>
                            )}
                            {state === "paused" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runGenerateAction(view, job, "resume")}
                              >
                                Resume
                              </Button>
                            )}
                            {(state === "running" || state === "queued" || state === "paused") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runGenerateAction(view, job, "cancel")}
                              >
                                Cancel
                              </Button>
                            )}
                            {(state === "completed" || state === "failed" || state === "cancelled") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runGenerateAction(view, job, "retry")}
                              >
                                Retry
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              },
            },
            {
              // #3539: the provider's deliver jobs as pipeline jobs —
              // the generate column's shape, one stage later (the
              // delivery copy + per-channel outcomes).
              key: "deliverJobs",
              header: "Deliver Jobs",
              cellClassName: "dpp-col-feed-cell",
              render: (view) => {
                const jobs = view.deliverJobs ?? [];
                if (jobs.length === 0) {
                  return <span className="dpp-feed-none">No deliver jobs</span>;
                }
                const busy = actingId === view.id;
                return (
                  <div className="dpp-feed-jobs">
                    {jobs.map((job) => {
                      const state = job.pipeline?.state ?? "unknown";
                      const lastRun = job.deliver?.lastRun ?? null;
                      const snapshot = job.deliver?.snapshot ?? null;
                      const ageLabel = snapshot
                        ? snapshot.ageSeconds < 90
                          ? `${snapshot.ageSeconds}s old`
                          : snapshot.ageSeconds < 5400
                            ? `${Math.round(snapshot.ageSeconds / 60)}m old`
                            : `${(snapshot.ageSeconds / 3600).toFixed(1)}h old`
                        : null;
                      return (
                        <div key={job.jobId} className="dpp-feed-job">
                          <div className="dpp-feed-head">
                            <span className="dpp-feed-label">{job.label}</span>
                            <span className={`dpp-feed-state dpp-feed-state-${state}`}>
                              {state}
                            </span>
                          </div>
                          <div className="dpp-feed-meta">
                            {job.deliver?.state === "never-run" || !lastRun ? (
                              <span>Never run</span>
                            ) : (
                              <span>
                                {`Last run: ${lastRun.status} ${fmtDataProviderTime(lastRun.finishedAt)} (${lastRun.received}/${lastRun.requested} channels)`}
                              </span>
                            )}
                            {snapshot && (
                              <span>
                                {`Delivered: ${snapshot.pairsDelivered} pairs · channels: ${snapshot.channelsDelivered.join(", ") || "none"} · ${ageLabel}${snapshot.stale ? " · STALE" : ""}`}
                              </span>
                            )}
                            {snapshot?.reports.map((report) => (
                              <span key={report.kind}>
                                {`${report.kind}: ${report.channels.map((c) => `${c.channel}=${c.status}`).join(", ") || "none"}`}
                              </span>
                            ))}
                            {snapshot?.inputRunId && (
                              <span>{`Derived from generate run: ${snapshot.inputRunId}`}</span>
                            )}
                            {job.nextScheduledRun && (
                              <span>{`Next run: ${fmtDataProviderTime(job.nextScheduledRun)}`}</span>
                            )}
                            {lastRun?.codedError && (
                              <span className="dpp-feed-error">{lastRun.codedError}</span>
                            )}
                          </div>
                          {(job.deliver?.history?.length ?? 0) > 1 && (
                            <ul className="dpp-feed-history">
                              {job.deliver!.history.slice(1, 4).map((run) => (
                                <li key={run.runId}>
                                  {`${run.status} · ${fmtDataProviderTime(run.finishedAt)} · ${run.received}/${run.requested} channels`}
                                </li>
                              ))}
                            </ul>
                          )}
                          <div className="dpp-feed-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void runDeliverAction(view, job, "run")}
                            >
                              Run
                            </Button>
                            {(state === "running" || state === "queued") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runDeliverAction(view, job, "pause")}
                              >
                                Pause
                              </Button>
                            )}
                            {state === "paused" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runDeliverAction(view, job, "resume")}
                              >
                                Resume
                              </Button>
                            )}
                            {(state === "running" || state === "queued" || state === "paused") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runDeliverAction(view, job, "cancel")}
                              >
                                Cancel
                              </Button>
                            )}
                            {(state === "completed" || state === "failed" || state === "cancelled") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runDeliverAction(view, job, "retry")}
                              >
                                Retry
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              },
            },
            {
              // #3540: the provider's composed pipeline chains —
              // the end-to-end roll-up (per-stage states + the
              // current frontier) with chain-level and
              // frontier-stage management, reusing the feed-job
              // cell classes (no new stylesheet).
              key: "pipelineChains",
              header: "Pipeline",
              cellClassName: "dpp-col-feed-cell",
              render: (view) => {
                const chains = view.pipelineChains ?? [];
                if (chains.length === 0) {
                  return <span className="dpp-feed-none">No pipeline</span>;
                }
                const busy = actingId === view.id;
                return (
                  <div className="dpp-feed-jobs">
                    {chains.map((chain) => {
                      const state = chain.pipeline?.state ?? "unknown";
                      const frontierStage = chain.frontier
                        ? chain.stages.find((s) => s.stage === chain.frontier)
                        : undefined;
                      return (
                        <div key={chain.jobId} className="dpp-feed-job">
                          <div className="dpp-feed-head">
                            <span className="dpp-feed-label">{chain.label}</span>
                            <span className={`dpp-feed-state dpp-feed-state-${state}`}>
                              {state}
                            </span>
                          </div>
                          <div className="dpp-feed-meta">
                            {chain.pipeline?.lastRunStatus ? (
                              <span>
                                {`Last run: ${chain.pipeline.lastRunStatus} ${fmtDataProviderTime(chain.pipeline.lastRunAt)}`}
                              </span>
                            ) : (
                              <span>Never run</span>
                            )}
                            <span>
                              {chain.stages
                                .map((s) => `${s.stage}: ${s.status}`)
                                .join(" · ")}
                            </span>
                            {chain.frontier && (
                              <span>{`Frontier: ${chain.frontier}`}</span>
                            )}
                            {frontierStage?.error && (
                              <span className="dpp-feed-error">{frontierStage.error}</span>
                            )}
                            {chain.pipeline?.lastError && (
                              <span className="dpp-feed-error">{chain.pipeline.lastError}</span>
                            )}
                            {chain.nextScheduledRun && (
                              <span>{`Next run: ${fmtDataProviderTime(chain.nextScheduledRun)}`}</span>
                            )}
                          </div>
                          <div className="dpp-feed-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void runChainAction(view, chain, "run")}
                            >
                              Run
                            </Button>
                            {(state === "running" || state === "queued") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runChainAction(view, chain, "pause")}
                              >
                                Pause
                              </Button>
                            )}
                            {state === "paused" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runChainAction(view, chain, "resume")}
                              >
                                Resume
                              </Button>
                            )}
                            {(state === "running" || state === "queued" || state === "paused") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runChainAction(view, chain, "cancel")}
                              >
                                Cancel
                              </Button>
                            )}
                            {(state === "completed" || state === "failed" || state === "cancelled") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void runChainAction(view, chain, "retry")}
                              >
                                Retry
                              </Button>
                            )}
                            {frontierStage && frontierStage.status === "running" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() =>
                                  void runChainAction(view, chain, "stage_pause", frontierStage.stage)
                                }
                              >
                                {`Pause ${frontierStage.stage}`}
                              </Button>
                            )}
                            {frontierStage && frontierStage.status === "stopped" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() =>
                                  void runChainAction(view, chain, "stage_resume", frontierStage.stage)
                                }
                              >
                                {`Resume ${frontierStage.stage}`}
                              </Button>
                            )}
                            {frontierStage &&
                              frontierStage.status !== "completed" &&
                              frontierStage.status !== "cancelled" &&
                              frontierStage.status !== "not-run" && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() =>
                                    void runChainAction(view, chain, "stage_cancel", frontierStage.stage)
                                  }
                                >
                                  {`Cancel ${frontierStage.stage}`}
                                </Button>
                              )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              },
            },
            {
              key: "capabilities",
              header: "Capabilities & Routes",
              cellClassName: "dpp-col-capabilities-cell",
              render: (view) => {
                const myRoutes = routes.filter(
                  (r) => r.primaryProviderId === view.id || r.gapFillProviderId === view.id
                );
                return (
                  <div className="dpp-col-capabilities">
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
                );
              },
            },
            {
              key: "connectivity",
              header: "Connectivity & Session",
              cellClassName: "dpp-col-session-cell",
              render: (view) => (
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
              ),
            },
            {
              key: "actions",
              header: "Actions",
              cellClassName: "dpp-col-actions-cell",
              render: (view) => {
                const busy = actingId === view.id;
                return (
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
                );
              },
            },
          ]}
          rows={providers}
          rowKey={(view) => view.id}
          rowProps={(view) => ({
            "data-provider-id": view.id,
          } as React.HTMLAttributes<HTMLTableRowElement>)}
          rowClassName="dpp-item"
          className="dpp-table"
          containerClassName="dpp-table-container"
        />
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
