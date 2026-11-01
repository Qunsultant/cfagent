/**
 * Service tokens section for the IAAA admin panel (issue #2681).
 *
 * Rendered on the Overview tab beside ServiceUserSection: like the
 * service-user tiers, service tokens are platform state, so the
 * section lives with them instead of growing a new tab (tab indices
 * unchanged) and is not duplicated anywhere else. The panel itself
 * gates behind the overview route, so non-admins never reach this
 * section; its own 401/403 handling is defense in depth, and a
 * denied state never renders a button that silently fails.
 *
 * The plaintext secret is shown EXACTLY ONCE, in the mint/rotate
 * result below — the server stores only its SHA-256 hash, so a token
 * that is lost cannot be recovered, only revoked and replaced.
 * Rotation invalidates the old secret immediately.
 *
 * All calls go through src/client/apiFetch.ts (the #71 rule).
 */

import { useCallback, useEffect, useState } from "react";
import { Button, Checkbox, EmptyState, Notice, Select, Spinner, TextInput } from "./components/ui";
import {
  fetchServiceTokens,
  fmtServiceTokenTime,
  mintServiceToken,
  rotateServiceToken,
  revokeServiceToken,
  type ServiceTokenInfo,
  type ServiceTokenTier,
} from "./serviceTokensApi";
import "./serviceTokensPanel.css";

const ROLE_OPTIONS = ["platform-admin", "tenant-admin", "member", "approver", "auditor"] as const;

export function ServiceTokensPanel() {
  const [tokens, setTokens] = useState<ServiceTokenInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [tier, setTier] = useState<ServiceTokenTier>("platform");
  const [tenantId, setTenantId] = useState("");
  const [roles, setRoles] = useState<string[]>(["member"]);
  const [expiryDays, setExpiryDays] = useState("90");
  const [minting, setMinting] = useState(false);
  /** The one-time plaintext secret from the most recent mint/rotate. */
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [rotatingId, setRotatingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setTokens(await fetchServiceTokens());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load service tokens.");
      setTokens([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleRole = (role: string) => {
    setRoles((current) =>
      current.includes(role) ? current.filter((r) => r !== role) : [...current, role],
    );
  };

  const expiryMs = () => {
    const days = Number.parseInt(expiryDays, 10);
    if (!Number.isFinite(days) || days <= 0) return null;
    return Date.now() + days * 86_400_000;
  };

  const handleMint = async () => {
    const expiresAtMs = expiryMs();
    if (expiresAtMs === null) {
      setError("Expiry must be a positive number of days.");
      return;
    }
    if (roles.length === 0) {
      setError("Select at least one role.");
      return;
    }
    if (tier === "tenant" && tenantId.trim().length === 0) {
      setError("Tenant id is required for tenant tokens.");
      return;
    }
    setMinting(true);
    setError("");
    setCopied(false);
    try {
      const { secret } = await mintServiceToken({
        label: label.trim(),
        tier,
        tenantId: tier === "tenant" ? tenantId.trim() : undefined,
        roles,
        expiresAtMs,
      });
      setFreshSecret(secret);
      setLabel("");
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create service token.");
    } finally {
      setMinting(false);
    }
  };

  const handleCopy = async () => {
    if (!freshSecret) return;
    try {
      await navigator.clipboard.writeText(freshSecret);
      setCopied(true);
    } catch {
      setError("Copy failed — select the token text and copy it manually.");
    }
  };

  const handleRotate = async (id: string) => {
    const expiresAtMs = expiryMs();
    if (expiresAtMs === null) {
      setError("Expiry must be a positive number of days.");
      return;
    }
    setRotatingId(id);
    setError("");
    setCopied(false);
    try {
      const { secret } = await rotateServiceToken(id, expiresAtMs);
      setFreshSecret(secret);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to rotate service token.");
    } finally {
      setRotatingId(null);
    }
  };

  const handleRevoke = async (id: string) => {
    setRevokingId(id);
    setError("");
    try {
      await revokeServiceToken(id);
      setConfirmingRevokeId(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to revoke service token.");
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div className="stp-panel">
      <p className="stp-desc">
        Service tokens let non-interactive callers act as the service identity. Send a token as{" "}
        <code>Authorization: Bearer svc_…</code>. A platform token works platform-wide; a tenant
        token works only inside its tenant. Treat a token like a password — anyone holding it
        can use it until it expires or you revoke it.
      </p>

      {error && (
        <Notice tone="danger" onDismiss={() => setError("")}>
          {error}
        </Notice>
      )}

      {freshSecret && (
        <div className="stp-secret" role="status">
          <span className="stp-secret-label">Your new service token — copy it now:</span>
          <code className="stp-secret-value">{freshSecret}</code>
          <div className="stp-secret-actions">
            <Button size="sm" variant="primary" onClick={handleCopy}>
              {copied ? "Copied ✓" : "Copy token"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setFreshSecret(null)}>
              Dismiss
            </Button>
          </div>
          <span className="stp-secret-note">
            You won&apos;t see this token again. The server stores only a hash of it, so a lost
            token can only be revoked and replaced. Rotation invalidates the old token immediately.
          </span>
        </div>
      )}

      <div className="stp-mint-form">
        <div className="stp-mint-row">
          <TextInput
            id="stp-label"
            label="New token label"
            placeholder="e.g. Nightly report automation"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            wrapperClassName="stp-label-field"
          />
          <Select
            id="stp-tier"
            label="Scope"
            value={tier}
            onChange={(event) => setTier(event.target.value as ServiceTokenTier)}
            wrapperClassName="stp-tier-field"
          >
            <option value="platform">Platform</option>
            <option value="tenant">Tenant</option>
          </Select>
          {tier === "tenant" && (
            <TextInput
              id="stp-tenant"
              label="Tenant id"
              placeholder="e.g. tenant-a"
              value={tenantId}
              onChange={(event) => setTenantId(event.target.value)}
              wrapperClassName="stp-tenant-field"
            />
          )}
          <TextInput
            id="stp-expiry"
            label="Expiry (days)"
            placeholder="90"
            value={expiryDays}
            onChange={(event) => setExpiryDays(event.target.value)}
            wrapperClassName="stp-expiry-field"
          />
        </div>
        <fieldset className="stp-roles">
          <legend className="stp-roles-label">Roles (least privilege — only what the token needs)</legend>
          <div className="stp-roles-list">
            {ROLE_OPTIONS.map((role) => (
              <Checkbox
                key={role}
                label={role}
                checked={roles.includes(role)}
                onChange={() => toggleRole(role)}
              />
            ))}
          </div>
          <span className="stp-roles-note">
            Roles you cannot grant are refused by the server. Workspace-admin is not available
            on tokens (no workspace binding exists for them).
          </span>
        </fieldset>
        <Button variant="primary" onClick={handleMint} loading={minting} disabled={minting}>
          Create token
        </Button>
      </div>

      {loading ? (
        <div className="stp-loading">
          <Spinner size="sm" /> Loading service tokens…
        </div>
      ) : tokens.length === 0 ? (
        <EmptyState
          title="No service tokens yet"
          description="Create a token to let automation act as the service identity. Tokens you create appear here with their scope, roles, and expiry."
        />
      ) : (
        <ul className="stp-list">
          {tokens.map((token) => (
            <li key={token.id} className="stp-item">
              <div className="stp-item-meta">
                <span className="stp-item-label">{token.label}</span>
                <code className="stp-item-prefix">{token.prefix}…</code>
                <span className="stp-item-scope">
                  {token.tier === "tenant" ? `Tenant ${token.tenantId}` : "Platform"}
                  {" · "}
                  {token.roles.join(", ")}
                  {token.revokedAtMs !== null && " · Revoked"}
                </span>
                <span className="stp-item-times">
                  Expires {fmtServiceTokenTime(token.expiresAtMs)} · Last used{" "}
                  {fmtServiceTokenTime(token.lastUsedAtMs)}
                </span>
              </div>
              {token.revokedAtMs === null &&
                (confirmingRevokeId === token.id ? (
                  <div className="stp-item-actions">
                    <span className="stp-confirm-text">
                      Revoke this token? Callers using it stop working immediately.
                    </span>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => handleRevoke(token.id)}
                      loading={revokingId === token.id}
                      disabled={revokingId === token.id}
                    >
                      Confirm revoke
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmingRevokeId(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="stp-item-actions">
                    <Button
                      size="sm"
                      variant="primary"
                      tone="subtle"
                      onClick={() => handleRotate(token.id)}
                      loading={rotatingId === token.id}
                      disabled={rotatingId === token.id}
                    >
                      Rotate
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      tone="subtle"
                      onClick={() => setConfirmingRevokeId(token.id)}
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
