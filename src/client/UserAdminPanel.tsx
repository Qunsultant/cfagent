/**
 * User administration panel (#2220, program #2218 slice 2).
 *
 * READ-ONLY views, nothing here edits a user, a tenant, or an
 * account: grants live in the IAAA surfaces and account writes
 * in the commercial operator surfaces. Two views, both served by
 * src/agents/routes/platformUsers.ts:
 * - Your profile: the signed-in account's verified-login
 *   identity, tenant memberships, and commercial account
 *   linkage, fetched from the self-only endpoint. The panel
 *   never sends a user id or tenant id: the server scopes the
 *   view to the verified session login.
 * - Operator lookup: a login typed into the form below is a
 *   lookup key, never scope — the server answers only for
 *   platform-admin callers, and the tenant shown is the
 *   target's stored tenant. A refusal surfaces as an error,
 *   never as an empty result.
 *
 * All calls go through src/client/apiFetch.ts (the #71 rule).
 * The panel renders only payloads that pass the shape guard;
 * a 401/403 body or garbage must never reach the table.
 * Built strictly with src/client/components/ui/ primitives and
 * token-only styling per docs/agents/ux-architecture.md §20.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  EmptyState,
  Notice,
  Spinner,
  Stack,
  Table,
  TextInput,
} from "./components/ui";
import { apiFetch } from "./apiFetch";

export interface PlatformUserMembershipView {
  membershipId: string;
  tenantId: string;
  roles: Array<{ role: string; scope: string }>;
  createdAtMs: number;
  revokedAtMs?: number;
}

export interface PlatformUserAccountView {
  tenantId: string;
  tier: string;
  creditsUSD: number;
  includedRuns: number;
  updatedAtMs: number;
}

export interface PlatformUserView {
  userLogin: string;
  tenantId: string | null;
  hasAccount: boolean;
  tier: string;
  creditsUSD: number;
  includedRunsRemaining: number;
  membershipSource: "wired" | "unmapped";
  memberships: PlatformUserMembershipView[];
  account: PlatformUserAccountView | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMembership(value: unknown): value is PlatformUserMembershipView {
  if (!isRecord(value)) return false;
  if (typeof value.membershipId !== "string") return false;
  if (typeof value.tenantId !== "string") return false;
  if (!Array.isArray(value.roles)) return false;
  if (typeof value.createdAtMs !== "number") return false;
  return value.roles.every(
    (r) =>
      isRecord(r) && typeof r.role === "string" && typeof r.scope === "string",
  );
}

/** Shape guard: true only for a well-formed user view payload. */
export function isPlatformUserView(value: unknown): value is PlatformUserView {
  if (!isRecord(value)) return false;
  if (typeof value.userLogin !== "string") return false;
  if (value.tenantId !== null && typeof value.tenantId !== "string") return false;
  if (typeof value.hasAccount !== "boolean") return false;
  if (typeof value.tier !== "string") return false;
  if (typeof value.creditsUSD !== "number") return false;
  if (typeof value.includedRunsRemaining !== "number") return false;
  if (value.membershipSource !== "wired" && value.membershipSource !== "unmapped") return false;
  if (!Array.isArray(value.memberships) || !value.memberships.every(isMembership)) return false;
  if (value.account !== null) {
    if (!isRecord(value.account)) return false;
    if (typeof value.account.tenantId !== "string") return false;
    if (typeof value.account.tier !== "string") return false;
    if (typeof value.account.creditsUSD !== "number") return false;
    if (typeof value.account.includedRuns !== "number") return false;
    if (typeof value.account.updatedAtMs !== "number") return false;
  }
  return true;
}

async function send<T>(path: string): Promise<T> {
  const resp = await apiFetch(path);
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  return data;
}

/** Fetch the caller's own profile; throws on 401/503 with the server message. */
export async function fetchOwnUserView(): Promise<PlatformUserView> {
  const data = await send<unknown>("/api/admin/platform-users/me");
  if (!isPlatformUserView(data)) throw new Error("Unexpected user view response.");
  return data;
}

/** Operator lookup by login; throws on 401/403/400 with the server message. */
export async function fetchUserViewByLogin(login: string): Promise<PlatformUserView> {
  const data = await send<unknown>(
    `/api/admin/platform-users/lookup?login=${encodeURIComponent(login)}`,
  );
  if (!isPlatformUserView(data)) throw new Error("Unexpected user view response.");
  return data;
}

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function UserViewSection({ view, heading }: { view: PlatformUserView; heading: string }) {
  return (
    <Stack gap="1-5">
      <div className="section-label-row">
        <span>{heading}</span>
        <small>Verified login, tenant memberships &amp; account linkage</small>
      </div>
      <div>
        <div>
          <strong>Verified login:</strong> {view.userLogin}
        </div>
        <div>
          <strong>Tenant:</strong>{" "}
          {view.tenantId ?? "No tenant — no commercial account yet"}
        </div>
        <div>
          <strong>Tier:</strong> {view.tier}
        </div>
        <div>
          <strong>Credits:</strong> ${view.creditsUSD.toFixed(2)}
        </div>
        <div>
          <strong>Included runs remaining:</strong> {view.includedRunsRemaining}
        </div>
      </div>
      {view.account ? (
        <div>
          <div className="section-label-row">
            <span>Account linkage</span>
            <small>Stored commercial account for this login</small>
          </div>
          <div>
            <div>
              <strong>Account tenant:</strong> {view.account.tenantId}
            </div>
            <div>
              <strong>Stored tier:</strong> {view.account.tier}
            </div>
            <div>
              <strong>Credits:</strong> ${view.account.creditsUSD.toFixed(2)}
            </div>
            <div>
              <strong>Included runs:</strong> {view.account.includedRuns}
            </div>
            <div>
              <strong>Last updated:</strong> {fmtTime(view.account.updatedAtMs)}
            </div>
          </div>
        </div>
      ) : (
        <Notice tone="info">
          No commercial account is linked to this login yet. Paid runs fail
          closed for this user until an account is set up; free runs are
          unaffected.
        </Notice>
      )}
      <div>
        <div className="section-label-row">
          <span>Tenant memberships</span>
          <small>IAAA memberships for this login</small>
        </div>
        {view.membershipSource === "unmapped" ? (
          <Notice tone="info">
            No wired IAAA identity was found for this login, so memberships
            cannot be listed. That is not the same as having no memberships.
          </Notice>
        ) : null}
        <Table<PlatformUserMembershipView>
          columns={[
            { key: "tenant", header: "Tenant", render: (row) => row.tenantId },
            {
              key: "roles",
              header: "Roles",
              render: (row) => row.roles.map((r) => `${r.role} (${r.scope})`).join(", "),
            },
            {
              key: "created",
              header: "Created",
              render: (row) => fmtTime(row.createdAtMs),
            },
            {
              key: "status",
              header: "Status",
              render: (row) =>
                row.revokedAtMs !== undefined
                  ? `Revoked ${fmtTime(row.revokedAtMs)}`
                  : "Active",
            },
          ]}
          rows={view.memberships}
          rowKey={(row) => row.membershipId}
          empty={
            <EmptyState
              title="No tenant memberships found"
              description="This login holds no IAAA membership rows."
            />
          }
        />
      </div>
    </Stack>
  );
}

export function UserAdminPanel() {
  const [self, setSelf] = useState<PlatformUserView | null>(null);
  const [selfLoading, setSelfLoading] = useState(true);
  const [selfError, setSelfError] = useState("");
  const [lookupLogin, setLookupLogin] = useState("");
  const [lookup, setLookup] = useState<PlatformUserView | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState("");

  const loadSelf = useCallback(async () => {
    setSelfLoading(true);
    setSelfError("");
    try {
      setSelf(await fetchOwnUserView());
    } catch (err) {
      setSelfError(err instanceof Error ? err.message : "Failed to load your profile.");
      setSelf(null);
    } finally {
      setSelfLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSelf();
  }, [loadSelf]);

  const handleLookup = useCallback(async () => {
    const login = lookupLogin.trim();
    if (!login) {
      setLookupError("Enter a login to look up.");
      return;
    }
    setLookupLoading(true);
    setLookupError("");
    try {
      setLookup(await fetchUserViewByLogin(login));
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : "Lookup failed.");
      setLookup(null);
    } finally {
      setLookupLoading(false);
    }
  }, [lookupLogin]);

  return (
    <Stack gap="1-5">
      <Notice tone="info">
        View-only: this surface shows user profiles, tenant memberships, and
        account linkage. It never edits a user, tenant, or account.
      </Notice>
      {selfLoading ? (
        <Spinner />
      ) : selfError ? (
        <Notice tone="danger">{selfError}</Notice>
      ) : self ? (
        <UserViewSection view={self} heading="Your profile (signed-in account)" />
      ) : null}
      <div className="section-label-row">
        <span>Operator user lookup</span>
        <small>Platform-admin only — other callers get a refusal, not an empty result</small>
      </div>
      <TextInput
        label="Look up a user by login"
        value={lookupLogin}
        onChange={(e) => setLookupLogin(e.target.value)}
        placeholder="e.g. operator-user"
      />
      <div>
        <Button onClick={() => void handleLookup()} loading={lookupLoading}>
          Look up user
        </Button>
      </div>
      {lookupError ? <Notice tone="danger">{lookupError}</Notice> : null}
      {lookup ? (
        <UserViewSection view={lookup} heading={`Lookup result: ${lookup.userLogin}`} />
      ) : null}
    </Stack>
  );
}
