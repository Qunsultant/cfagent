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
import { Card, EmptyState, Flex, Notice, Spinner, Stack } from "./components/ui";
import { formatIdentityText, Identity } from "./identityDisplay";
import {
  fetchRoleGrants,
  fmtRoleGrantTime,
  type RoleGrantInfo,
} from "./roleGrantsApi";

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
    // #6164 (A3) — retired roleGrantsPanel.deprecated.css: layout and text
    // come from the ui primitives only (Stack/Flex/Card + ui-meta), the
    // ApiKeysPanel pattern. No bespoke class remains in this file.
    <Stack gap="3">
      <p className="ui-meta">
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
        <Flex gap="2" align="center">
          <Spinner size="sm" /> <span className="ui-meta">Loading role grants…</span>
        </Flex>
      ) : grants.length === 0 ? (
        <EmptyState
          title="No admin grants yet"
          description="Admin roles are granted from Grant membership on the Members tab. Grants appear here with who granted them and when."
        />
      ) : (
        <Stack gap="2">
          {grants.map((grant) => (
            <Card key={grant.grantId} padding="sm">
              <Flex justify="between" align="center" gap="3" wrap>
                <Stack gap="1">
                  {/* #6164 (F8) — the grantee is a login beside the id, never
                  a bare hash; the identity binding stays as the fallback. */}
                  <span className="ui-mono">
                    <Identity login={grant.login ?? grant.identity} id={grant.internalUserId} />
                  </span>
                  <span className="ui-meta">
                    {grant.role} ({grant.scope}) · Tenant {grant.tenantId}
                    {grant.revoked && " · Revoked"}
                  </span>
                  <span className="ui-meta">
                    Granted by {formatIdentityText(grant.grantedByLogin, grant.grantedBy)} · {fmtRoleGrantTime(grant.grantedAtMs)}
                    {grant.email ? ` · ${grant.email}` : ""}
                  </span>
                </Stack>
              </Flex>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
