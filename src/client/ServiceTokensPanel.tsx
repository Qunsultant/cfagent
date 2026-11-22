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
import { Button, Card, Checkbox, EmptyState, Flex, Notice, Select, Spinner, Stack, TextInput } from "./components/ui";
import { formatIdentityText, Identity } from "./identityDisplay";
import {
  fetchServiceTokens,
  fmtServiceTokenTime,
  mintServiceToken,
  rotateServiceToken,
  revokeServiceToken,
  SERVICE_TOKEN_ROLE_OPTIONS,
  type ServiceTokenInfo,
  type ServiceTokenTier,
} from "./serviceTokensApi";

const ROLE_OPTIONS = SERVICE_TOKEN_ROLE_OPTIONS;

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
    // #6164 (A3) — retired serviceTokensPanel.deprecated.css: layout and
    // text come from the ui primitives only (Stack/Flex/Card/Notice +
    // ui-meta/ui-mono), the ApiKeysPanel pattern. The roles fieldset is
    // now a Stack with a strong group label — no ui utility resets a
    // fieldset, and no new utility is added in this slice.
    <Stack gap="3">
      <p className="ui-meta">
        Service tokens let non-interactive callers act as the service identity. Send a token as{" "}
        <code className="ui-mono">Authorization: Bearer svc_…</code>. A platform token works platform-wide; a tenant
        token works only inside its tenant. Treat a token like a password — anyone holding it
        can use it until it expires or you revoke it.
      </p>

      {error && (
        <Notice tone="danger" onDismiss={() => setError("")}>
          {error}
        </Notice>
      )}

      {freshSecret && (
        <Notice tone="warning">
          <Stack gap="2">
            <strong>Your new service token — copy it now:</strong>
            <code className="ui-mono">{freshSecret}</code>
            <Flex gap="2" wrap>
              <Button size="sm" variant="primary" onClick={handleCopy}>
                {copied ? "Copied ✓" : "Copy token"}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setFreshSecret(null)}>
                Dismiss
              </Button>
            </Flex>
            <span className="ui-meta">
              You won&apos;t see this token again. The server stores only a hash of it, so a lost
              token can only be revoked and replaced. Rotation invalidates the old token immediately.
            </span>
          </Stack>
        </Notice>
      )}

      <Stack gap="2">
        <Flex gap="2" align="end" wrap>
          <TextInput
            id="stp-label"
            label="New token label"
            placeholder="e.g. Nightly report automation"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            wrapperClassName="ui-grow"
          />
          <Select
            id="stp-tier"
            label="Scope"
            value={tier}
            onChange={(event) => setTier(event.target.value as ServiceTokenTier)}
            wrapperClassName="ui-grow"
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
              wrapperClassName="ui-grow"
            />
          )}
          <TextInput
            id="stp-expiry"
            label="Expiry (days)"
            placeholder="90"
            value={expiryDays}
            onChange={(event) => setExpiryDays(event.target.value)}
            wrapperClassName="ui-grow"
          />
        </Flex>
        <Stack gap="1">
          <strong className="ui-meta">Roles (least privilege — only what the token needs)</strong>
          <Flex gap="3" wrap>
            {ROLE_OPTIONS.map((role) => (
              <Checkbox
                key={role}
                label={role}
                checked={roles.includes(role)}
                onChange={() => toggleRole(role)}
              />
            ))}
          </Flex>
          <span className="ui-footnote">
            Roles you cannot grant are refused by the server. Workspace-admin is not available
            on tokens (no workspace binding exists for them).
          </span>
        </Stack>
        <Button variant="primary" onClick={handleMint} loading={minting} disabled={minting}>
          Create token
        </Button>
      </Stack>

      {loading ? (
        <Flex gap="2" align="center">
          <Spinner size="sm" /> <span className="ui-meta">Loading service tokens…</span>
        </Flex>
      ) : tokens.length === 0 ? (
        <EmptyState
          title="No service tokens yet"
          description="Create a token to let automation act as the service identity. Tokens you create appear here with their scope, roles, and expiry."
        />
      ) : (
        <Stack gap="2">
          {tokens.map((token) => (
            <Card key={token.id} padding="sm">
              <Flex justify="between" align="center" gap="3" wrap>
                <Stack gap="0-5">
                  <strong>{token.label}</strong>
                  <code className="ui-mono">{token.prefix}…</code>
                  <span className="ui-meta-sm">
                    {token.tier === "tenant" ? `Tenant ${token.tenantId}` : "Platform"}
                    {" · "}
                    {token.roles.join(", ")}
                    {token.revokedAtMs !== null && " · Revoked"}
                  </span>
                  {/* #6164 (F7) — the token's service identity and its minter. */}
                  <span className="ui-meta-sm">
                    Service: <Identity login={token.serviceLogin} id={token.serviceInternalUserId} />
                    {" · Minted by "}
                    {formatIdentityText(token.createdByLogin, token.createdBy)}
                  </span>
                  <span className="ui-meta-sm">
                    Expires {fmtServiceTokenTime(token.expiresAtMs)} · Last used{" "}
                    {fmtServiceTokenTime(token.lastUsedAtMs)}
                  </span>
                </Stack>
                {token.revokedAtMs === null &&
                  (confirmingRevokeId === token.id ? (
                    <Flex gap="2" align="center" wrap>
                      <span className="ui-danger">
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
                      <Button size="sm" variant="secondary" onClick={() => setConfirmingRevokeId(null)}>
                        Cancel
                      </Button>
                    </Flex>
                  ) : (
                    <Flex gap="2" align="center" wrap>
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
                    </Flex>
                  ))}
              </Flex>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
