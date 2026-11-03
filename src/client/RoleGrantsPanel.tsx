/**
 * Role grants section for the IAAA admin panel (issue #2688).
 *
 * Rendered on the Overview tab beside ServiceTokensPanel and
 * ServiceUserSection: like them, role grants are platform state,
 * so the section lives with them instead of growing a new tab
 * (tab indices unchanged) and is not duplicated anywhere else.
 * Tenant-admins who reach this panel through the limited admin
 * view (see IaaaAdminPanel) see only their own tenant's grants:
 * the server scopes the list, the panel never filters by itself
 * as an enforcement step.
 *
 * Nothing client-side decides authorization: every button calls
 * a real endpoint, and a server refusal (non-granter, self-grant,
 * cross-tenant, stale auth for the step-up obligation) surfaces
 * as an error instead of a hidden button.
 *
 * All calls go through src/client/apiFetch.ts (the #71 rule).
 */

import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Notice, Select, Spinner, TextInput } from "./components/ui";
import {
  fetchRoleGrants,
  fmtRoleGrantTime,
  grantRoleGrant,
  revokeRoleGrant,
  ROLE_GRANT_ROLE_OPTIONS,
  type RoleGrantInfo,
} from "./roleGrantsApi";
import "./roleGrantsPanel.css";

const ROLE_OPTIONS = ROLE_GRANT_ROLE_OPTIONS;

export function RoleGrantsPanel() {
  const [grants, setGrants] = useState<RoleGrantInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [target, setTarget] = useState("");
  const [role, setRole] = useState<string>("tenant-admin");
  const [tenantId, setTenantId] = useState("");
  const [email, setEmail] = useState("");
  const [granting, setGranting] = useState(false);
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

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

  const handleGrant = async () => {
    if (target.trim() === "") {
      setError("A target internal user id is required.");
      return;
    }
    setGranting(true);
    setError("");
    setNotice("");
    try {
      const result = await grantRoleGrant({
        internalUserId: target.trim(),
        role,
        ...(role === "tenant-admin" && tenantId.trim() !== "" ? { tenantId: tenantId.trim() } : {}),
        ...(email.trim() !== "" ? { email: email.trim() } : {}),
      });
      setNotice(
        result.alreadyGranted
          ? "That user already holds this admin role — nothing was duplicated."
          : "Role granted. It takes effect immediately.",
      );
      setTarget("");
      setTenantId("");
      setEmail("");
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to grant role.");
    } finally {
      setGranting(false);
    }
  };

  const handleRevoke = async (grant: RoleGrantInfo) => {
    setRevokingId(grant.grantId);
    setError("");
    setNotice("");
    try {
      await revokeRoleGrant(grant.membershipId, grant.bindingIndex);
      setConfirmingRevokeId(null);
      setNotice("Role revoked. The user loses that admin role immediately.");
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to revoke role grant.");
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div className="rgp-panel">
      <p className="rgp-desc">
        Admin roles are granted explicitly — signing in through any provider grants no admin
        role by itself. A platform admin grants platform-admin; a tenant admin grants
        tenant-admin within their own tenant only. Granting yourself a role is refused by
        the server, and every grant and revoke is audited. Revocation takes effect immediately.
      </p>

      {error && (
        <Notice tone="danger" onDismiss={() => setError("")}>
          {error}
        </Notice>
      )}
      {notice && (
        <Notice tone="success" onDismiss={() => setNotice("")}>
          {notice}
        </Notice>
      )}

      <div className="rgp-grant-form">
        <div className="rgp-grant-row">
          <TextInput
            id="rgp-target"
            label="Target internal user id"
            placeholder="e.g. v1:…"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            wrapperClassName="rgp-target-field"
          />
          <Select
            id="rgp-role"
            label="Role"
            value={role}
            onChange={(event) => setRole(event.target.value)}
            wrapperClassName="rgp-role-field"
          >
            {ROLE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
          {role === "tenant-admin" && (
            <TextInput
              id="rgp-tenant"
              label="Tenant id (blank = this tenant)"
              placeholder="e.g. primary"
              value={tenantId}
              onChange={(event) => setTenantId(event.target.value)}
              wrapperClassName="rgp-tenant-field"
            />
          )}
          <TextInput
            id="rgp-email"
            label="Grantee email (optional)"
            placeholder="e.g. admin@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            wrapperClassName="rgp-email-field"
          />
        </div>
        <Button variant="primary" onClick={handleGrant} loading={granting} disabled={granting}>
          Grant role
        </Button>
      </div>

      {loading ? (
        <div className="rgp-loading">
          <Spinner size="sm" /> Loading role grants…
        </div>
      ) : grants.length === 0 ? (
        <EmptyState
          title="No admin grants yet"
          description="Grant platform-admin or tenant-admin above. Grants you create appear here with who granted them and when."
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
              {!grant.revoked &&
                (confirmingRevokeId === grant.grantId ? (
                  <div className="rgp-item-actions">
                    <span className="rgp-confirm-text">
                      Revoke this admin role? The user loses it immediately.
                    </span>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => handleRevoke(grant)}
                      loading={revokingId === grant.grantId}
                      disabled={revokingId === grant.grantId}
                    >
                      Confirm revoke
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmingRevokeId(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="rgp-item-actions">
                    <Button
                      size="sm"
                      variant="danger"
                      tone="subtle"
                      onClick={() => setConfirmingRevokeId(grant.grantId)}
                    >
                      Revoke
                    </Button>
                  </div>
                ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
