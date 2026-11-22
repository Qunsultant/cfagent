/**
 * Role grants section for the IAAA admin panel (issue #2688).
 *
 * Rendered on the Overview tab beside ServiceTokensPanel and
 * ServiceUserSection: like them, role grants are platform state,
 * so the section lives with them instead of growing a new tab
 * (tab indices unchanged).
 *
 * Issue #6165 — one admin-creation path: this section no longer
 * grants or revokes. Granting and revoking happen in exactly one
 * place — Grant membership on the Members tab
 * (POST /api/iaaa/membership/grant, the single minting seam).
 * This section keeps only the read-only admin-role list (who
 * holds which admin role, who granted it, when) and points at
 * the Members tab. Tenant-admins who reach this panel through
 * the limited admin view (see IaaaAdminPanel) see only their own
 * tenant's grants: the server scopes the list, the panel never
 * filters by itself as an enforcement step.
 *
 * Nothing client-side decides authorization: the server decides
 * every refusal, and a server refusal surfaces as an error
 * instead of a hidden element.
 *
 * All calls go through src/client/apiFetch.ts (the #71 rule).
 */

import { useCallback, useEffect, useState } from "react";
import { EmptyState, Notice, Spinner } from "./components/ui";
import {
  fetchRoleGrants,
  fmtRoleGrantTime,
  type RoleGrantInfo,
} from "./roleGrantsApi";
import "./roleGrantsPanel.deprecated.css";

export function RoleGrantsPanel() {
  const [grants, setGrants] = useState<RoleGrantInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setGrants(await fetchRoleGrants());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load role grants.");
      setGrants([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="rgp-panel">
      <p className="rgp-desc">
        Admin roles are granted explicitly — signing in through any provider grants no admin
        role by itself. A platform admin grants platform-admin; a tenant admin grants
        tenant-admin within their own tenant only. Granting yourself a role is refused by
        the server, and every grant and revoke is audited. Revocation takes effect immediately.
        {/* Issue #6165: one admin-creation path — this section grants
        nothing; the Members tab is the one grant surface. */}
        Grant or revoke admin roles from Grant membership on the Members tab.
      </p>

      {error && (
        <Notice tone="danger" onDismiss={() => setError("")}>
          {error}
        </Notice>
      )}

      {loading ? (
        <div className="rgp-loading">
          <Spinner size="sm" /> Loading role grants…
        </div>
      ) : grants.length === 0 ? (
        <EmptyState
          title="No admin grants yet"
          description="Admin roles are granted from Grant membership on the Members tab. Grants appear here with who granted them and when."
        />
      ) : (
        <ul className="rgp-list">
          {grants.map((grant) => (
            <li key={grant.grantId} className="rgp-item">
              <div className="rgp-item-meta">
                <span className="rgp-item-user">{grant.identity ?? grant.internalUserId}</span>
                <span className="rgp-item-role">
                  {grant.role} ({grant.scope}) · Tenant {grant.tenantId}
                  {grant.revoked && " · Revoked"}
                </span>
                <span className="rgp-item-times">
                  Granted by {grant.grantedBy} · {fmtRoleGrantTime(grant.grantedAtMs)}
                  {grant.email ? ` · ${grant.email}` : ""}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
