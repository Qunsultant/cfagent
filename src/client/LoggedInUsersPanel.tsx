/**
 * Logged-in users section for the IAAA admin panel (issue #2836).
 *
 * Rendered on the Overview tab beside ServiceTokensPanel,
 * RoleGrantsPanel, and PolicyProposalsPanel: like them, this is
 * admin state, so the section lives with them instead of growing
 * a new tab (tab indices unchanged) and is not duplicated
 * anywhere else. Tenant-admins who reach this panel through the
 * limited admin view (see IaaaAdminPanel) see only their own
 * tenant's users: the server scopes the list, the panel never
 * filters by itself as an enforcement step.
 *
 * Nothing client-side decides authorization: every button calls
 * a real endpoint, and a server refusal (non-admin,
 * cross-tenant revoke, stale session) surfaces as an error
 * instead of a hidden button. Revoke is confirm-gated per
 * session, and the result notice reports whether the revoke was
 * audited — a revoke whose audit write failed is shown as such,
 * never as a clean success.
 *
 * All calls go through src/client/loggedInUsersApi.ts (apiFetch,
 * the #71 rule). Counts are rendered with their basis: the
 * coverage note states that loginCount counts retained audit
 * events only, so the panel never presents it as a lifetime
 * total.
 */

import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Notice, Select, Spinner, TextInput } from "./components/ui";
import {
  fetchLoggedInUsers,
  fetchQuotaUsage,
  fmtLoggedInTime,
  grantQuotaOverride,
  revokeLoggedInSession,
  type LoggedInUsersResponse,
  type QuotaUsageResponse,
} from "./loggedInUsersApi";
import "./loggedInUsersPanel.css";

export function LoggedInUsersPanel() {
  const [data, setData] = useState<LoggedInUsersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmingSessionId, setConfirmingSessionId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  // Issue #2842: quota lookup + override grant, additive to
  // this panel (the list above is unchanged). The server scopes
  // every lookup/grant; a refusal surfaces as an error here.
  const [quotaLogin, setQuotaLogin] = useState("");
  const [quotaData, setQuotaData] = useState<QuotaUsageResponse | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaError, setQuotaError] = useState("");
  const [grantWindow, setGrantWindow] = useState<"daily" | "weekly" | "monthly">("daily");
  const [grantRuns, setGrantRuns] = useState("5");
  const [grantReason, setGrantReason] = useState("");
  const [granting, setGranting] = useState(false);

  const lookupQuota = useCallback(async () => {
    const login = quotaLogin.trim();
    if (login === "") {
      setQuotaError("Enter a user login to look up.");
      return;
    }
    setQuotaLoading(true);
    setQuotaError("");
    try {
      setQuotaData(await fetchQuotaUsage(login));
    } catch (err: unknown) {
      setQuotaError(err instanceof Error ? err.message : "Failed to load quota usage.");
      setQuotaData(null);
    } finally {
      setQuotaLoading(false);
    }
  }, [quotaLogin]);

  const grant = useCallback(async () => {
    const login = quotaLogin.trim();
    const runs = Number(grantRuns);
    if (login === "" || !Number.isInteger(runs) || runs < 1 || grantReason.trim() === "") {
      setQuotaError("A grant needs a login, whole extra runs >= 1, and a reason.");
      return;
    }
    setGranting(true);
    setQuotaError("");
    try {
      const result = await grantQuotaOverride({
        userLogin: login,
        windowKind: grantWindow,
        extraRuns: runs,
        reason: grantReason.trim(),
      });
      setNotice(
        result.audited
          ? `Quota override granted: +${result.override.extraRuns} ${result.override.windowKind} runs for ${login}.`
          : `Quota override granted, but the audit write failed — investigate before relying on the audit trail: +${result.override.extraRuns} ${result.override.windowKind} runs for ${login}.`,
      );
      setQuotaData(await fetchQuotaUsage(login));
    } catch (err: unknown) {
      setQuotaError(err instanceof Error ? err.message : "Failed to grant quota override.");
    } finally {
      setGranting(false);
    }
  }, [quotaLogin, grantWindow, grantRuns, grantReason]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await fetchLoggedInUsers());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load logged-in users.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = useCallback(
    async (sessionId: string) => {
      setRevokingId(sessionId);
      setError("");
      setNotice("");
      try {
        const result = await revokeLoggedInSession(sessionId);
        setNotice(
          result.audited
            ? `Session revoked and audited: ${result.revokedSessionId}.`
            : `Session revoked, but the audit write failed — investigate before relying on the audit trail: ${result.revokedSessionId}.`,
        );
        setConfirmingSessionId(null);
        await load();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to revoke session.");
      } finally {
        setRevokingId(null);
      }
    },
    [load],
  );

  return (
    <div className="lup-panel">
      <p className="lup-desc">
        Active sessions and per-user login history from the durable records. Each row below is
        one active login session. Login counts cover retained audit events only — see the
        coverage note below.
      </p>
      <p className="lup-desc">
        Each row is one active login session. Created = when this login happened. Last seen = its
        last activity. Expires = when it stops counting as active (last activity + 8-hour idle
        window). Revoke ends only this session.
      </p>
      {notice !== "" && <Notice tone="success">{notice}</Notice>}
      {error !== "" && <Notice tone="danger">{error}</Notice>}
      <div className="lup-item">
        <div className="lup-item-meta">
          <span className="lup-item-user">Request quota</span>
          <span className="lup-desc">
            Per-user report-run quota (issue 2842): daily 10, weekly 70, monthly 300 runs for all
            tiers, pending the CBO/owner decision. Look up a user by their screener login to
            see remaining quota and active overrides, or grant extra runs for the current window.
          </span>
          <span className="lup-item-count">
            <TextInput
              aria-label="User login for quota lookup"
              value={quotaLogin}
              onChange={(e) => setQuotaLogin(e.target.value)}
              placeholder="user login"
            />{" "}
            <Button disabled={quotaLoading} onClick={() => void lookupQuota()}>
              Look up quota
            </Button>
          </span>
          {quotaError !== "" && <Notice tone="danger">{quotaError}</Notice>}
          {quotaLoading && (
            <div className="lup-loading">
              <Spinner />
            </div>
          )}
          {quotaData && (
            <>
              <span className="lup-item-times">
                {quotaData.userLogin} · partition {quotaData.tenantPartition} · Daily:{" "}
                {quotaData.usage.daily.usage}/{quotaData.usage.daily.limit} (remaining{" "}
                {quotaData.usage.daily.remaining}, resets {fmtLoggedInTime(quotaData.usage.daily.resetAtMs)}) ·
                Weekly: {quotaData.usage.weekly.usage}/{quotaData.usage.weekly.limit} (remaining{" "}
                {quotaData.usage.weekly.remaining}, resets {fmtLoggedInTime(quotaData.usage.weekly.resetAtMs)}) ·
                Monthly: {quotaData.usage.monthly.usage}/{quotaData.usage.monthly.limit} (remaining{" "}
                {quotaData.usage.monthly.remaining}, resets {fmtLoggedInTime(quotaData.usage.monthly.resetAtMs)})
              </span>
              <span className="lup-item-count">
                <Select
                  aria-label="Override window"
                  value={grantWindow}
                  onChange={(e) => setGrantWindow(e.target.value as "daily" | "weekly" | "monthly")}
                >
                  <option value="daily">daily</option>
                  <option value="weekly">weekly</option>
                  <option value="monthly">monthly</option>
                </Select>{" "}
                <TextInput
                  aria-label="Extra runs"
                  value={grantRuns}
                  onChange={(e) => setGrantRuns(e.target.value)}
                  placeholder="extra runs"
                />{" "}
                <TextInput
                  aria-label="Override reason"
                  value={grantReason}
                  onChange={(e) => setGrantReason(e.target.value)}
                  placeholder="reason (audited)"
                />{" "}
                <Button disabled={granting} onClick={() => void grant()}>
                  Grant override
                </Button>
              </span>
            </>
          )}
        </div>
      </div>
      {loading && (
        <div className="lup-loading">
          <Spinner />
        </div>
      )}
      {!loading && data && data.users.length === 0 && (
        <EmptyState title="No active sessions" description="No sessions pass the active-session check right now." />
      )}
      {!loading && data && data.users.length > 0 && (
        <>
          <ul className="lup-list">
            {data.users.map((user) => (
              <li key={user.internalUserId ?? `legacy:${user.displayLogin}`} className="lup-item">
                <div className="lup-item-meta">
                  <span className="lup-item-user">{user.identity ?? user.displayLogin}</span>
                  <span className="lup-item-tenants">
                    {user.tenantIds.length > 0 ? user.tenantIds.join(", ") : "no tenant attribution"}
                  </span>
                  <span className="lup-item-count">
                    Recorded logins: {user.loginCount === null ? "—" : String(user.loginCount)}
                  </span>
                  <span className="lup-item-times">
                    First: {fmtLoggedInTime(user.firstLoginMs)} · Most recent:{" "}
                    {fmtLoggedInTime(user.mostRecentLoginMs)} · First seen:{" "}
                    {fmtLoggedInTime(user.firstSeenMs)}
                  </span>
                  {user.recentLoginMs.length > 0 && (
                    <span className="lup-item-recent">
                      Recent: {user.recentLoginMs.map(fmtLoggedInTime).join(", ")}
                    </span>
                  )}
                </div>
                <ul className="lup-sessions">
                  {user.sessions.map((session) => (
                    <li key={session.sessionId} className="lup-session">
                      <span className="lup-session-id">{session.sessionId}</span>
                      <span className="lup-session-provider">
                        {session.provider ?? "unknown provider"}
                      </span>
                      <span className="lup-session-times">
                        Created: {fmtLoggedInTime(session.createdMs)} · Last seen:{" "}
                        {fmtLoggedInTime(session.lastSeenMs)} · Expires:{" "}
                        {fmtLoggedInTime(session.expiresMs)}
                      </span>
                      {confirmingSessionId === session.sessionId ? (
                        <div className="lup-session-actions">
                          <span className="lup-confirm-text">
                            Revoke this session immediately?
                          </span>
                          <Button
                            disabled={revokingId === session.sessionId}
                            onClick={() => void revoke(session.sessionId)}
                          >
                            Confirm revoke
                          </Button>
                          <Button
                            disabled={revokingId === session.sessionId}
                            onClick={() => setConfirmingSessionId(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <div className="lup-session-actions">
                          <Button
                            disabled={revokingId === session.sessionId}
                            onClick={() => setConfirmingSessionId(session.sessionId)}
                          >
                            Revoke
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <p className="lup-note">
            {data.coverage.loginCountNote} {data.coverage.lastSeenNote}{" "}
            {data.coverage.firstSeenNote}
          </p>
        </>
      )}
    </div>
  );
}
