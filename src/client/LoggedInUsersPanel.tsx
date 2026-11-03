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
import { Button, EmptyState, Notice, Spinner } from "./components/ui";
import {
  fetchLoggedInUsers,
  fmtLoggedInTime,
  revokeLoggedInSession,
  type LoggedInUsersResponse,
} from "./loggedInUsersApi";
import "./loggedInUsersPanel.css";

export function LoggedInUsersPanel() {
  const [data, setData] = useState<LoggedInUsersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmingSessionId, setConfirmingSessionId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

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
        Active sessions and per-user login history from the durable records. Login counts cover
        retained audit events only — see the coverage note below.
      </p>
      {notice !== "" && <Notice tone="success">{notice}</Notice>}
      {error !== "" && <Notice tone="danger">{error}</Notice>}
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
