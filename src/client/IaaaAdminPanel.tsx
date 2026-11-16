/**
 * IAAA Admin panel (issue 945, IAAA-UI v1 + v2; mutations added by
 * issue #1758).
 *
 * v1: the platform admin's own memberships + role bindings, the
 * tenant's platform-genesis status, and recent tenant audit events
 * from GET /api/iaaa/overview. v2 adds a tabbed endpoint/event
 * explorer on top of the same gate: the API route table from
 * server.ts, the MCP catalogs, the IAAA audit-event taxonomy, and
 * the mapping tables between them. The explorer tabs are static
 * code knowledge (no user data) and render only after the overview
 * fetch succeeds — the panel stays gated behind the overview route
 * as a whole. The server is the gate; on 403 this panel shows a
 * plain "not an admin" state and fetches nothing else.
 *
 * #1758 mutations: the Members tab grants, revokes, and edits
 * memberships, and the Overview tab offers self-deactivation.
 * Access-request approve/deny (from #1274) was already a mutation
 * here. The audit/catalog tabs stay read-only. Nothing client-side
 * decides authorization: every mutation can still 403 server-side
 * (non-granter, self-grant, stale auth for the step-up obligation),
 * and the panel surfaces that refusal instead of hiding it.
 *
 * #2173 admin-counts slice: the Overview tab also shows
 * system-wide admin counts (platform admins + tenant admins with
 * a per-tenant breakdown) from the overview route. Counts only —
 * no member identities; the Members tab remains the surface that
 * lists identities.
 */

import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Modal, Notice, Select, Spinner, Table, Tabs, TabPanel, TextInput } from "./components/ui";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import {
  deactivateSelf,
  decideAccessRequest,
  editMembershipApi,
  fetchAccessRequests,
  fetchAdminOverview,
  fetchMemberships,
  formatEventTime,
  grantMembershipApi,
  revokeMembershipApi,
  type AccessRequestView,
  type AdminMembershipView,
  type AdminOverview,
} from "./iaaaAdminApi";
import {
  IAAA_ADMIN_SECTIONS,
  IAAA_ADMIN_SECTION_LABELS,
  type IaaaAdminSection,
} from "./iaaaAdminSections";
import {
  API_ENDPOINT_CATALOG,
  IAAA_AUDIT_EVENT_CATALOG,
  IAAA_CATALOG_GAPS,
  IAAA_CORRELATION_ROWS,
} from "./iaaaEndpointCatalog";
import {
  MCP_PROMPTS_CATALOG,
  MCP_RESOURCES_CATALOG,
  MCP_TOOLS_CATALOG,
} from "./mcpEndpointsData";
import { ServiceUserSection } from "./ServiceUserSection";
import { ServiceTokensPanel } from "./ServiceTokensPanel";
import { RoleGrantsPanel } from "./RoleGrantsPanel";
import { BootstrapProposalsPanel } from "./BootstrapProposalsPanel";
import { LoggedInUsersPanel } from "./LoggedInUsersPanel";
import { fetchRoleGrants } from "./roleGrantsApi";
import { fetchLoggedInUsers } from "./loggedInUsersApi";
import "./iaaaAdminPanel.css";

type IaaaAdminTab = "overview" | "members" | "api" | "mcp" | "iaaa" | "correlations";

const IAAA_ADMIN_TABS = [
  { id: "overview", label: "Overview" },
  { id: "members", label: "Members" },
  { id: "api", label: "API" },
  { id: "mcp", label: "MCP" },
  { id: "iaaa", label: "IAAA" },
  { id: "correlations", label: "Correlations" },
  // Issue #3121 S2: the Queue tab (#2173) moved out — the admin queue
  // is now a view of the schedules home (`?tab=schedules&view=queue`,
  // ScheduleQueueView, same platform-admin overview gate). The old
  // address `?tab=platform-admin&view=iaaa-admin&iaaaTab=queue`
  // redirects there (schedulesHome.ts `legacySchedulesRedirect`).
] as const;

const MEMBER_ROLES = ["member", "approver", "auditor", "workspace-admin", "tenant-admin", "platform-admin"] as const;
const MEMBER_SCOPES = ["tenant", "workspace", "platform"] as const;

export function IaaaAdminPanel() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notAdmin, setNotAdmin] = useState(false);
  // #2688: a tenant-admin fails the platform-gated overview fetch
  // but may still hold role-grant rights in their own tenant. When
  // the overview gate refuses, one role-grants list probe decides
  // whether the limited tenant-admin view below renders; the
  // server scopes that list, so this probe grants nothing itself.
  const [roleGrantsAllowed, setRoleGrantsAllowed] = useState(false);
  useEffect(() => {
    if (!notAdmin) return;
    let cancelled = false;
    fetchRoleGrants()
      .then(() => {
        if (!cancelled) setRoleGrantsAllowed(true);
      })
      .catch(() => {
        /* stays in the not-an-admin state */
      });
    return () => {
      cancelled = true;
    };
  }, [notAdmin]);
  // #2836: same probe shape as role grants — a tenant-admin
  // fails the platform-gated overview fetch but may still hold
  // logged-in-users rights in their own tenant. When the
  // overview gate refuses, one logged-in-users list probe
  // decides whether that section renders in the limited view;
  // the server scopes that list, so this probe grants nothing.
  const [loggedInUsersAllowed, setLoggedInUsersAllowed] = useState(false);
  useEffect(() => {
    if (!notAdmin) return;
    let cancelled = false;
    fetchLoggedInUsers()
      .then(() => {
        if (!cancelled) setLoggedInUsersAllowed(true);
      })
      .catch(() => {
        /* stays in the not-an-admin state */
      });
    return () => {
      cancelled = true;
    };
  }, [notAdmin]);
  // Deep links (#2776): the IAAA tabs live in `?iaaaTab=` via the shared
  // hook (aliased to the old tab/setTab names, so the panel below and
  // the members lazy-load effect are untouched). `view` is taken by the
  // admin section, hence a distinct inner param.
  const { activeTab: tab, handleTabChange: setTab } = useUrlSyncedTabs<IaaaAdminTab>({
    param: "iaaaTab",
    isValid: (v): v is IaaaAdminTab =>
      IAAA_ADMIN_TABS.some((t) => t.id === v),
    defaultTab: "overview",
  });
  // #4821: the Overview tab's stacked sections are sub-tabs of their
  // own (`?iaaaSection=`), URL-synced by a second instance of the
  // shared hook. An unknown or missing section falls back to Summary;
  // the legacy `?iaaaTab=` values are untouched.
  const { activeTab: section, handleTabChange: setSection } = useUrlSyncedTabs<IaaaAdminSection>({
    param: "iaaaSection",
    isValid: (v): v is IaaaAdminSection =>
      IAAA_ADMIN_SECTIONS.some((s) => s === v),
    defaultTab: "summary",
  });
  // #1274: pending access requests for this tenant. A tenant-admin
  // without platform-admin never reaches this panel (the overview
  // gate is platform-admin), so the decide buttons serve admins who
  // hold both; the route itself accepts any tenant-admin granter.
  const [accessRequests, setAccessRequests] = useState<AccessRequestView[]>([]);
  const [accessError, setAccessError] = useState("");
  const [accessNotice, setAccessNotice] = useState("");
  const [decidingId, setDecidingId] = useState<string | null>(null);
  // #1758: Members tab state. Memberships load lazily when the tab
  // is first selected; the grant/edit forms post to the server
  // routes, which enforce the no-self-grant and admin gates.
  const [memberships, setMemberships] = useState<AdminMembershipView[]>([]);
  const [membersError, setMembersError] = useState("");
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [grantTarget, setGrantTarget] = useState("");
  const [grantRole, setGrantRole] = useState<string>("member");
  const [grantScope, setGrantScope] = useState<string>("tenant");
  const [grantEmail, setGrantEmail] = useState("");
  const [grantWelcome, setGrantWelcome] = useState<{ sent: boolean; reason?: string } | null>(null);
  const [grantNotice, setGrantNotice] = useState("");
  const [editRole, setEditRole] = useState<Record<string, string>>({});
  const [editScope, setEditScope] = useState<Record<string, string>>({});
  const [deactivateArmed, setDeactivateArmed] = useState(false);
  const [deactivateResult, setDeactivateResult] = useState("");
  // Issue #4839 G10: a verified deactivation is success, not danger —
  // the result string alone cannot carry the tone, so the verified
  // flag travels with it.
  const [deactivateVerified, setDeactivateVerified] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setNotAdmin(false);
    try {
      setOverview(await fetchAdminOverview());
    } catch (err: any) {
      const message = err?.message || "Failed to load IAAA overview.";
      if (/403|Forbidden/.test(message)) {
        setNotAdmin(true);
      } else {
        setError(message);
      }
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAccessRequests = useCallback(async () => {
    setAccessError("");
    try {
      setAccessRequests(await fetchAccessRequests());
    } catch (err: any) {
      // A tenant-admin-only caller gets 403 here; the panel gate
      // already passed, so this is a backend failure, not a gate.
      setAccessError(err?.message || "Failed to load access requests.");
      setAccessRequests([]);
    }
  }, []);

  // #4821: access requests belong to their own sub-tab, so they load
  // only when it is visited — not on every Overview visit.
  useEffect(() => {
    if (
      !loading &&
      !notAdmin &&
      !error &&
      tab === "overview" &&
      section === "access-requests"
    ) {
      void loadAccessRequests();
    }
  }, [loading, notAdmin, error, tab, section, loadAccessRequests]);

  const loadMemberships = useCallback(async () => {
    setMembersError("");
    try {
      setMemberships(await fetchMemberships());
      setMembersLoaded(true);
    } catch (err: any) {
      setMembersError(err?.message || "Failed to load memberships.");
      setMemberships([]);
    }
  }, []);

  useEffect(() => {
    if (tab === "members" && !membersLoaded) void loadMemberships();
  }, [tab, membersLoaded, loadMemberships]);

  const grant = useCallback(async () => {
    if (grantTarget.trim() === "") {
      setMembersError("A target internal user id is required.");
      return;
    }
    setActingId("grant");
    setMembersError("");
    setGrantWelcome(null);
    setGrantNotice("");
    try {
      // #2661 — an optional grantee email is captured on the
      // record and best-effort triggers the welcome send.
      const result = await grantMembershipApi(
        grantTarget.trim(),
        [{ role: grantRole, scope: grantScope }],
        grantEmail.trim() === "" ? undefined : grantEmail.trim(),
      );
      // Issue #3155 (Q9): an admin-role grant from the first
      // approver proposes, it does not mint — say so plainly
      // instead of showing the success path.
      if (result.pending) {
        setGrantNotice(
          "Admin-role grant proposed — a second, distinct admin must approve the same grant before it mints.",
        );
        await loadMemberships();
        return;
      }
      setGrantTarget("");
      setGrantEmail("");
      setGrantWelcome(result.welcome ?? null);
      await loadMemberships();
    } catch (err: any) {
      setMembersError(err?.message || "Failed to grant membership.");
    } finally {
      setActingId(null);
    }
  }, [grantTarget, grantRole, grantScope, grantEmail, loadMemberships]);

  const [revokeTarget, setRevokeTarget] = useState<{ id: string; label: string } | null>(null);

  const revoke = useCallback(
    async (membershipId: string) => {
      setActingId(membershipId);
      setMembersError("");
      try {
        await revokeMembershipApi(membershipId);
        await loadMemberships();
      } catch (err: any) {
        setMembersError(err?.message || "Failed to revoke membership.");
      } finally {
        setActingId(null);
      }
    },
    [loadMemberships],
  );

  const edit = useCallback(
    async (membershipId: string) => {
      setActingId(membershipId);
      setMembersError("");
      try {
        await editMembershipApi(membershipId, [
          { role: editRole[membershipId] ?? "member", scope: editScope[membershipId] ?? "tenant" },
        ]);
        await loadMemberships();
      } catch (err: any) {
        setMembersError(err?.message || "Failed to edit membership.");
      } finally {
        setActingId(null);
      }
    },
    [editRole, editScope, loadMemberships],
  );

  const deactivate = useCallback(async () => {
    if (!deactivateArmed) {
      setDeactivateArmed(true);
      return;
    }
    setDeactivateArmed(false);
    try {
      const report = await deactivateSelf();
      setDeactivateVerified(report.verified);
      setDeactivateResult(
        report.verified
          ? "Deactivated: sessions, memberships, keys, and tokens revoked and verified."
          : `Deactivation completed with unverified items: ${report.residuals.join("; ") || "see report"}.`,
      );
    } catch (err: any) {
      setDeactivateVerified(false);
      setDeactivateResult(err?.message || "Failed to deactivate.");
    }
  }, [deactivateArmed]);

  const decide = useCallback(
    async (requestId: string, decision: "approve" | "deny") => {
      setDecidingId(requestId);
      setAccessError("");
      setAccessNotice("");
      try {
        const updated = await decideAccessRequest(requestId, decision);
        setAccessRequests((prev) => prev.map((r) => (r.requestId === requestId ? updated : r)));
        // Issue #3155 (Q9): a first approval leaves the request
        // pending — say so plainly, or the click looks like a no-op.
        if (decision === "approve" && updated.status === "pending") {
          setAccessNotice(
            "Approval recorded — a second, distinct admin must approve before the grant mints.",
          );
        }
      } catch (err: any) {
        setAccessError(err?.message || "Failed to decide the access request.");
      } finally {
        setDecidingId(null);
      }
    },
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner />;
  if (notAdmin) {
    // #2688 limited view: tenant-admins get the Role grants
    // section only — never Overview data, Service tokens, or
    // Service user state, which stay platform-gated server-side.
    // #2836 extends the limited view with Logged-in users for
    // the tenant admin's own tenant (server-scoped); Policy
    // proposals stay platform-only.
    if (roleGrantsAllowed || loggedInUsersAllowed) {
      return (
        <div className="iaaa-admin-panel">
          <p className="iaaa-admin-note">
            You are a tenant admin, not a platform admin. Only your own tenant&apos;s
            sections are available here; the rest of IAAA Admin requires platform-admin.
          </p>
          {roleGrantsAllowed && (
            <>
              <h4>Role grants</h4>
              <RoleGrantsPanel />
            </>
          )}
          {loggedInUsersAllowed && (
            <>
              <h4>Logged-in users</h4>
              <LoggedInUsersPanel />
            </>
          )}
        </div>
      );
    }
    return (
      <EmptyState
        title="Not an IAAA admin"
        description="This panel is only available to platform admins. If you should have access, sign in with an admin account."
      />
    );
  }
  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!overview) return <EmptyState title="No IAAA data" description="The overview came back empty." />;

  const roles = overview.memberships.flatMap((m) =>
    m.roleBindings.map((b) => `${b.role} (${b.scope})`),
  );

  return (
    <div className="iaaa-admin-panel">
      {/* Issue #4839 G1: the page states its purpose before the tab bar. */}
      <h3>IAAA Admin</h3>
      <p className="iaaa-admin-note">
        Identity and access administration for this platform: memberships, admin roles,
        service identities, and the audit trail. Platform admins see every section;
        tenant admins see only their own tenant&apos;s role grants and logged-in users.
      </p>
      <Modal
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        title="Revoke membership?"
        footer={
          <>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                const target = revokeTarget;
                setRevokeTarget(null);
                if (target) void revoke(target.id);
              }}
            >
              Revoke
            </Button>{" "}
            <Button type="button" variant="secondary" onClick={() => setRevokeTarget(null)}>
              Cancel
            </Button>
          </>
        }
      >
        <p>
          Revoke membership for {revokeTarget?.label}? The member loses access immediately.
        </p>
      </Modal>
      <Tabs
        tabs={[...IAAA_ADMIN_TABS]}
        value={tab}
        onChange={setTab}
        ariaLabel="IAAA admin sections"
        idBase="iaaa-admin"
      />

      <TabPanel idBase="iaaa-admin" tabId="overview" active={tab === "overview"}>
        {/* Issue #4821: the Overview sections are sub-tabs of their own
        (`?iaaaSection=`), re-homing the existing panels — moved, not
        duplicated. Inactive sections unmount (TabPanel default), so
        each section's panel fetches only when its sub-tab is visited. */}
        <Tabs
          tabs={IAAA_ADMIN_SECTIONS.map((id) => ({
            id,
            label: IAAA_ADMIN_SECTION_LABELS[id],
          }))}
          value={section}
          onChange={setSection}
          ariaLabel="IAAA admin overview sections"
          idBase="iaaa-admin-overview"
        />

        <TabPanel idBase="iaaa-admin-overview" tabId="summary" active={section === "summary"}>
        {/* Issue #4839 G2: the Summary section has a heading like every other section. */}
        <h4>Summary</h4>
        <div className="iaaa-admin-summary">
          <div>
            <span className="iaaa-admin-label">Tenant</span>
            <strong>{overview.tenantId}</strong>
          </div>
          <div>
            <span className="iaaa-admin-label">Your roles</span>
            <strong>{roles.length > 0 ? roles.join(", ") : "None"}</strong>
          </div>
          <div>
            <span className="iaaa-admin-label">Platform genesis</span>
            <strong>
              {overview.genesis.platformGenesisOccurred ? "Completed" : "Not yet occurred"}
            </strong>
          </div>
        </div>
        {/* Issue #4839 G3: dead ends get a way forward — verified against
        docs/architecture/security/iaaa-admin-bootstrap-genesis.md: genesis is the
        one-shot first platform: grant from the bootstrap list, and a role comes
        from a platform admin's grant, not from signing in. */}
        {!overview.genesis.platformGenesisOccurred && (
          <p className="iaaa-admin-note">
            Platform genesis has not yet occurred — no platform admin exists yet. The first
            platform admin comes from the bootstrap list (IAAA_BOOTSTRAP_ADMINS): the first
            platform: entry wins on that identity&apos;s next fresh sign-in. See Bootstrap
            proposals.
          </p>
        )}
        {roles.length === 0 && (
          <p className="iaaa-admin-note">
            You hold no roles — ask a platform admin to grant you a role from the Members tab.
          </p>
        )}

        {overview.adminCounts && (
          <>
            <h4>Admin counts</h4>
            <div className="iaaa-admin-summary">
              <div>
                <span className="iaaa-admin-label">Platform admins</span>
                <strong>{overview.adminCounts.platformAdmins}</strong>
              </div>
              <div>
                <span className="iaaa-admin-label">Tenant admins (all tenants)</span>
                <strong>{overview.adminCounts.tenantAdminsTotal}</strong>
              </div>
            </div>
            {overview.adminCounts.tenantAdminsByTenant.length === 0 ? (
              <EmptyState
                title="No tenant admins"
                description="No tenant-admin memberships recorded yet."
              />
            ) : (
              <Table
                columns={[
                  {
                    key: "tenant",
                    header: "Tenant",
                    render: (row) => <code>{row.tenantId}</code>,
                  },
                  {
                    key: "count",
                    header: "Tenant admins",
                    render: (row) => String(row.count),
                  },
                ]}
                rows={overview.adminCounts.tenantAdminsByTenant}
                rowKey={(row) => row.tenantId}
              />
            )}
          </>
        )}
        </TabPanel>

        <TabPanel idBase="iaaa-admin-overview" tabId="service-user" active={section === "service-user"}>
        {/* Issue #2501: service-user provisioning lives on Overview,
        not a new tab (tab indices unchanged) and not duplicated in
        the Queue tab: like admin counts and genesis, it is platform
        state. */}
        <h4>Service user</h4>
        <ServiceUserSection />
        </TabPanel>

        <TabPanel idBase="iaaa-admin-overview" tabId="service-tokens" active={section === "service-tokens"}>
        {/* Issue #2681: service tokens live on Overview beside the
        service-user section, not a new tab (tab indices unchanged)
        and not duplicated elsewhere: like the service-user tiers,
        they are platform state. */}
        <h4>Service tokens</h4>
        <ServiceTokensPanel />
        </TabPanel>

        <TabPanel idBase="iaaa-admin-overview" tabId="role-grants" active={section === "role-grants"}>
        {/* Issue #2688: human role grants live on Overview beside
        the service-user and service-token sections, not a new tab
        (tab indices unchanged) and not duplicated elsewhere: like
        them, admin grants are platform state. Tenant-admins reach
        this same section through the limited view above. */}
        <h4>Role grants</h4>
        <RoleGrantsPanel />
        </TabPanel>

        <TabPanel idBase="iaaa-admin-overview" tabId="bootstrap-proposals" active={section === "bootstrap-proposals"}>
        {/* Issue #3077 (#945 Q3): bootstrap proposals live on Overview beside
        the role-grants section, not a new tab (tab indices
        unchanged) and not duplicated elsewhere: like them, bootstrap
        administration is platform state. Tenant-admins never see
        this section (the limited view above returns early). */}
        <h4>Bootstrap proposals</h4>
        <BootstrapProposalsPanel />
        </TabPanel>

        <TabPanel idBase="iaaa-admin-overview" tabId="logged-in-users" active={section === "logged-in-users"}>
        {/* Issue #2836: logged-in users live on Overview beside
        the role-grants section, not a new tab (tab indices
        unchanged) and not duplicated elsewhere. Unlike policy
        proposals, tenant-admins DO reach this section through
        the limited view above — server-scoped to their tenant. */}
        <h4>Logged-in users</h4>
        <LoggedInUsersPanel />
        </TabPanel>

        <TabPanel idBase="iaaa-admin-overview" tabId="deactivate" active={section === "deactivate"}>
        <h4>Deactivate my account</h4>
        <p className="iaaa-admin-note">
          Deactivation revokes your sessions, memberships, API keys, and broker tokens,
          suppresses mail, and verifies the result. It cannot be undone from this panel.
          Click once to arm, again to confirm. If you deactivate by mistake, sign in
          again — deactivation does not block sign-in — then ask a platform admin to
          re-grant your roles from the Members tab. If your identity is still on the
          bootstrap list, a fresh sign-in restores tenant-admin automatically;
          platform-admin can only be re-granted by another platform admin.
        </p>
        {deactivateResult && (
          <Notice tone={deactivateVerified ? "success" : "danger"}>{deactivateResult}</Notice>
        )}
        <Button type="button" onClick={() => void deactivate()}>
          {deactivateArmed ? "Confirm deactivation" : "Deactivate my account"}
        </Button>
        </TabPanel>

        <TabPanel idBase="iaaa-admin-overview" tabId="access-requests" active={section === "access-requests"}>
        {/* Issue #4839 G9: the intro states the Q9 two-admin rule — a first
        approval only records; the grant mints after a second, distinct admin
        approves (the post-approval notice already says this). The "Audit events
        are read-only" sentence moved to the Audit events sub-tab, where it belongs. */}
        <p className="iaaa-admin-note">
          Pending access requests below can be approved or denied here. A first approval
          only records the approval — the grant mints after a second, distinct admin
          approves. Membership grant, revoke, and edit live on the Members tab.
        </p>

        <h4>Access requests</h4>
        {accessError && <Notice tone="danger">{accessError}</Notice>}
        {accessNotice && <Notice>{accessNotice}</Notice>}
        {accessRequests.length === 0 ? (
          <EmptyState title="No access requests" description="No elevation requests recorded for this tenant yet." />
        ) : (
          <Table
            columns={[
              { key: "requested", header: "Requested at", render: (r) => formatEventTime(r.createdAtMs) },
              {
                key: "requester",
                header: "Requester",
                render: (r) => <code>{r.requesterInternalUserId}</code>,
              },
              { key: "role", header: "Role", render: (r) => r.requestedRole },
              { key: "status", header: "Status", render: (r) => r.status },
              {
                key: "decision",
                header: "Decision",
                render: (r) =>
                  r.status === "pending" ? (
                    <>
                      <Button
                        type="button"
                        disabled={decidingId === r.requestId}
                        onClick={() => void decide(r.requestId, "approve")}
                      >
                        Approve
                      </Button>{" "}
                      <Button
                        type="button"
                        disabled={decidingId === r.requestId}
                        onClick={() => void decide(r.requestId, "deny")}
                      >
                        Deny
                      </Button>
                    </>
                  ) : (
                    "—"
                  ),
              },
            ]}
            rows={accessRequests}
            rowKey={(r) => r.requestId}
          />
        )}
        </TabPanel>

        <TabPanel idBase="iaaa-admin-overview" tabId="audit-events" active={section === "audit-events"}>
        <h4>Recent audit events</h4>
        {/* Issue #4839 G12: scope, legend, and the taxonomy link. The window is
        the overview cap (IAAA_ADMIN_OVERVIEW_LIMIT = 100, newest first, this
        tenant only) — verified in src/security/iaaaAdminOverview.ts. Decision
        and Outcome values are the catalog's own (allow/deny; succeeded/failed/
        unknown). The "Audit events are read-only" sentence moved here from
        Access requests (G9). */}
        <p className="iaaa-admin-note">
          The 100 most recent audit events for this tenant, newest first. Audit events are
          read-only. Decision is allow or deny; Outcome is whether the action succeeded,
          failed, or is unknown.
        </p>
        <Button type="button" variant="secondary" onClick={() => setTab("iaaa")}>
          See the IAAA tab taxonomy
        </Button>
        {overview.recentAuditEvents.length === 0 ? (
          <EmptyState title="No audit events" description="No events recorded for this tenant yet." />
        ) : (
          <Table
            columns={[
              { key: "time", header: "Time", render: (event) => formatEventTime(event.timestamp) },
              { key: "action", header: "Action", render: (event) => <code>{event.action}</code> },
              { key: "decision", header: "Decision", render: (event) => event.decision },
              { key: "outcome", header: "Outcome", render: (event) => event.outcome },
              {
                key: "correlation",
                header: "Correlation",
                render: (event) => <code>{event.correlationId}</code>,
              },
            ]}
            rows={overview.recentAuditEvents}
            rowKey={(event) => event.id}
          />
        )}
        </TabPanel>
      </TabPanel>

      <TabPanel idBase="iaaa-admin" tabId="members" active={tab === "members"}>
        <p className="iaaa-admin-note">
          Memberships in this tenant (platform admins see all tenants&apos; memberships).
          Granting yourself a role is refused server-side; a grant requires fresh
          authentication for the step-up obligation, so a stale session must sign in again.
          {/* Issue #4839 G5: the two grant surfaces explain themselves. */}
          Grant membership here assigns any role — member, approver, auditor, or an admin
          role — at tenant, workspace, or platform scope. Role grants on the Overview tab
          grants admin roles only.
        </p>
        {membersError && <Notice tone="danger">{membersError}</Notice>}
        {grantNotice && <Notice>{grantNotice}</Notice>}
        <h4>Grant membership</h4>
        {/* Issue #4839 G6: where the id comes from — the Memberships table
        below lists them; a wired sign-in's /api/me shows the caller's own. */}
        <TextInput
          label="Target internal user id"
          hint="Find it in the Memberships table below, or from /api/me after a wired sign-in."
          value={grantTarget}
          onChange={(e) => setGrantTarget(e.target.value)}
        />
        <Select
          label="Role"
          value={grantRole}
          onChange={(e) => setGrantRole(e.target.value)}
        >
          {MEMBER_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </Select>
        <Select
          label="Scope"
          value={grantScope}
          onChange={(e) => setGrantScope(e.target.value)}
        >
          {MEMBER_SCOPES.map((scope) => (
            <option key={scope} value={scope}>
              {scope}
            </option>
          ))}
        </Select>
        <TextInput
          label="Grantee email (optional)"
          value={grantEmail}
          onChange={(e) => setGrantEmail(e.target.value)}
        />
        <Button type="button" disabled={actingId === "grant"} onClick={() => void grant()}>
          Grant
        </Button>
        {grantWelcome && (
          <p>
            {grantWelcome.sent
              ? "Welcome mail sent."
              : `Welcome mail not sent${grantWelcome.reason ? ` (${grantWelcome.reason})` : ""}.`}
          </p>
        )}
        {/* Issue #4839 G7: what each role and scope can do — verified against
        the role catalog in src/security/authorization.ts (ROLE_GRANTS). */}
        <p className="iaaa-admin-note">
          Roles: member — uses the platform (tasks, artifacts, proposals, and their own
          brokerage); approver — approves actions only; auditor — reads tasks, artifacts,
          and the audit trail; workspace-admin — all permissions within one workspace;
          tenant-admin — all permissions within one tenant; platform-admin — assigns admin
          roles and reads the audit trail, platform scope only. Scopes: tenant — one
          tenant; workspace — one workspace; platform — the whole platform.
        </p>
        <h4>Memberships</h4>
        {memberships.length === 0 ? (
          <EmptyState title="No memberships" description="No memberships returned for this tenant yet." />
        ) : (
          <Table
            columns={[
              { key: "user", header: "User", render: (m) => <code>{m.internalUserId}</code> },
              { key: "tenant", header: "Tenant", render: (m) => m.tenantId },
              {
                key: "roles",
                header: "Roles",
                render: (m) =>
                  m.roleBindings.map((b) => `${b.role} (${b.scope})`).join(", "),
              },
              {
                key: "revoked",
                header: "Revoked",
                render: (m) => (m.revokedAtMs !== undefined ? "Yes" : "No"),
              },
              {
                key: "actions",
                header: "Actions",
                render: (m) =>
                  m.revokedAtMs !== undefined ? (
                    "—"
                  ) : (
                    <>
                      <Button
                        type="button"
                        disabled={actingId === m.membershipId}
                        onClick={() =>
                          setRevokeTarget({
                            id: m.membershipId,
                            label: `${m.internalUserId} (${m.tenantId})`,
                          })
                        }
                      >
                        Revoke
                      </Button>{" "}
                      <Select
                        label="Edit role"
                        value={editRole[m.membershipId] ?? "member"}
                        onChange={(e) =>
                          setEditRole((prev) => ({ ...prev, [m.membershipId]: e.target.value }))
                        }
                      >
                        {MEMBER_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {role}
                          </option>
                        ))}
                      </Select>{" "}
                      <Select
                        label="Edit scope"
                        value={editScope[m.membershipId] ?? "tenant"}
                        onChange={(e) =>
                          setEditScope((prev) => ({ ...prev, [m.membershipId]: e.target.value }))
                        }
                      >
                        {MEMBER_SCOPES.map((scope) => (
                          <option key={scope} value={scope}>
                            {scope}
                          </option>
                        ))}
                      </Select>{" "}
                      <Button
                        type="button"
                        disabled={actingId === m.membershipId}
                        onClick={() => void edit(m.membershipId)}
                      >
                        Save edit
                      </Button>
                    </>
                  ),
              },
            ]}
            rows={memberships}
            rowKey={(m) => m.membershipId}
          />
        )}
      </TabPanel>

      <TabPanel idBase="iaaa-admin" tabId="api" active={tab === "api"}>
        <p className="iaaa-admin-note">
          Every HTTP endpoint in the worker route table, derived from the server route
          branches. Aliases are one endpoint, not several. The catch-all forwarder is
          marked as such — it is not an endpoint.
        </p>
        {/* Issue #4839 G13: an endpoint count like the MCP tab's Tools/Resources/Prompts counts. */}
        <h4>Endpoints ({API_ENDPOINT_CATALOG.length})</h4>
        <Table
          columns={[
            {
              key: "method",
              header: "Method",
              render: (endpoint) => <code>{endpoint.method}</code>,
            },
            {
              key: "path",
              header: "Path",
              render: (endpoint) => (
                <>
                  <code>{endpoint.path}</code>
                  {endpoint.aliases.length > 0 && (
                    <div className="iaaa-admin-aliases">
                      aliases: {endpoint.aliases.join(", ")}
                    </div>
                  )}
                </>
              ),
            },
            {
              key: "gating",
              header: "Gating",
              render: (endpoint) => (
                <>
                  <span className="iaaa-admin-badge">{endpoint.auth}</span>
                  {endpoint.kind !== "http" && (
                    <span className="iaaa-admin-badge iaaa-admin-badge-kind">{endpoint.kind}</span>
                  )}
                </>
              ),
            },
            { key: "note", header: "Note", render: (endpoint) => endpoint.authNote },
          ]}
          rows={API_ENDPOINT_CATALOG}
          rowKey={(endpoint) => `${endpoint.method} ${endpoint.path}`}
        />
      </TabPanel>

      <TabPanel idBase="iaaa-admin" tabId="mcp" active={tab === "mcp"}>
        <p className="iaaa-admin-note">
          The MCP tools, resources, and prompts from the existing client catalog — reused,
          not duplicated. Server capabilities the catalog lacks are listed below as gaps.
        </p>
        <h4>Tools ({MCP_TOOLS_CATALOG.length})</h4>
        <Table
          columns={[
            { key: "name", header: "Name", render: (tool) => <code>{tool.name}</code> },
            { key: "category", header: "Category", render: (tool) => tool.category },
            { key: "description", header: "Description", render: (tool) => tool.description },
          ]}
          rows={MCP_TOOLS_CATALOG}
          rowKey={(tool) => tool.name}
        />
        <h4>Resources ({MCP_RESOURCES_CATALOG.length})</h4>
        <Table
          columns={[
            {
              key: "uri",
              header: "URI",
              render: (resource) => <code>{resource.uri}</code>,
            },
            { key: "name", header: "Name", render: (resource) => resource.name },
            { key: "description", header: "Description", render: (resource) => resource.description },
          ]}
          rows={MCP_RESOURCES_CATALOG}
          rowKey={(resource) => resource.uri}
        />
        <h4>Prompts ({MCP_PROMPTS_CATALOG.length})</h4>
        <Table
          columns={[
            { key: "name", header: "Name", render: (prompt) => <code>{prompt.name}</code> },
            { key: "description", header: "Description", render: (prompt) => prompt.description },
          ]}
          rows={MCP_PROMPTS_CATALOG}
          rowKey={(prompt) => prompt.name}
        />
        <h4>Not in this catalog (server capabilities reported as gaps)</h4>
        <Table
          columns={[
            { key: "capability", header: "Capability", render: (gap) => <code>{gap.item}</code> },
            { key: "detail", header: "Detail", render: (gap) => gap.detail },
          ]}
          rows={IAAA_CATALOG_GAPS.filter((gap) => gap.area === "mcp")}
          rowKey={(gap) => gap.item}
        />
      </TabPanel>

      <TabPanel idBase="iaaa-admin" tabId="iaaa" active={tab === "iaaa"}>
        <p className="iaaa-admin-note">
          The full IAAA audit-event taxonomy the code can emit, with the builder and the
          live emitting site for each event. Occurrences that emit no audit event are
          listed below as gaps — never fabricated into events.
        </p>
        <h4>Audit events</h4>
        <Table
          columns={[
            { key: "action", header: "Action", render: (event) => <code>{event.action}</code> },
            { key: "decision", header: "Decision", render: (event) => event.decision },
            { key: "outcome", header: "Outcome", render: (event) => event.outcome },
            {
              key: "emitted",
              header: "Emitted",
              render: (event) => (event.emitted ? "Yes" : "No — builder only"),
            },
            {
              key: "builder",
              header: "Builder / emitter",
              render: (event) => (
                <>
                  <div>{event.builder}</div>
                  {event.emitter && <div className="iaaa-admin-aliases">{event.emitter}</div>}
                </>
              ),
            },
            { key: "fields", header: "Fields", render: (event) => event.fields.join(", ") },
          ]}
          rows={IAAA_AUDIT_EVENT_CATALOG}
          rowKey={(event) => `${event.action} ${event.decision} ${event.outcome}`}
        />
        <h4>Gaps — IAAA occurrences with no audit event</h4>
        <Table
          columns={[
            { key: "occurrence", header: "Occurrence", render: (gap) => <code>{gap.item}</code> },
            { key: "detail", header: "Detail", render: (gap) => gap.detail },
          ]}
          rows={IAAA_CATALOG_GAPS.filter((gap) => gap.area === "iaaa")}
          rowKey={(gap) => gap.item}
        />
      </TabPanel>

      <TabPanel idBase="iaaa-admin" tabId="correlations" active={tab === "correlations"}>
        <p className="iaaa-admin-note">
          Mapping tables. Rows with no counterpart are shown as UNMAPPED, not forced into
          a match. Every row cites its source in the catalog module.
        </p>
        <h4>API endpoint ↔ MCP tool</h4>
        <Table
          columns={[
            { key: "endpoint", header: "Endpoint", render: (row) => <code>{row.left}</code> },
            {
              key: "mcp",
              header: "MCP entry",
              render: (row) => (row.right === null ? "UNMAPPED" : <code>{row.right}</code>),
            },
            {
              key: "relation",
              header: "Relation",
              render: (row) => <span className="iaaa-admin-badge">{row.relation}</span>,
            },
            { key: "note", header: "Note", render: (row) => row.note },
          ]}
          rows={IAAA_CORRELATION_ROWS.filter((row) => row.kind === "endpoint-mcp")}
          rowKey={(_row, index) => `endpoint-mcp-${index}`}
        />
        <h4>IAAA event ↔ endpoint</h4>
        <Table
          columns={[
            {
              key: "event",
              header: "Event / occurrence",
              render: (row) => <code>{row.left}</code>,
            },
            {
              key: "endpoint",
              header: "Endpoint",
              render: (row) => (row.right === null ? "UNMAPPED" : <code>{row.right}</code>),
            },
            {
              key: "relation",
              header: "Relation",
              render: (row) => <span className="iaaa-admin-badge">{row.relation}</span>,
            },
            { key: "note", header: "Note", render: (row) => row.note },
          ]}
          rows={IAAA_CORRELATION_ROWS.filter((row) => row.kind === "event-endpoint")}
          rowKey={(_row, index) => `event-endpoint-${index}`}
        />
      </TabPanel>
    </div>
  );
}
