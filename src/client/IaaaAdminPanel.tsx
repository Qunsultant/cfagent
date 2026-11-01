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
import { AdminQueueWipePanel } from "./AdminQueueWipePanel";
import { ServiceUserSection } from "./ServiceUserSection";
import { ServiceTokensPanel } from "./ServiceTokensPanel";
import "./iaaaAdminPanel.css";

type IaaaAdminTab = "overview" | "members" | "api" | "mcp" | "iaaa" | "correlations" | "queue";

const IAAA_ADMIN_TABS = [
  { id: "overview", label: "Overview" },
  { id: "members", label: "Members" },
  { id: "api", label: "API" },
  { id: "mcp", label: "MCP" },
  { id: "iaaa", label: "IAAA" },
  { id: "correlations", label: "Correlations" },
  // #2173 queue wipe slice: appended last so existing tab indices are unchanged.
  { id: "queue", label: "Queue" },
] as const;

const MEMBER_ROLES = ["member", "approver", "auditor", "workspace-admin", "tenant-admin", "platform-admin"] as const;
const MEMBER_SCOPES = ["tenant", "workspace", "platform"] as const;

export function IaaaAdminPanel() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notAdmin, setNotAdmin] = useState(false);
  const [tab, setTab] = useState<IaaaAdminTab>("overview");
  // #1274: pending access requests for this tenant. A tenant-admin
  // without platform-admin never reaches this panel (the overview
  // gate is platform-admin), so the decide buttons serve admins who
  // hold both; the route itself accepts any tenant-admin granter.
  const [accessRequests, setAccessRequests] = useState<AccessRequestView[]>([]);
  const [accessError, setAccessError] = useState("");
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
  const [editRole, setEditRole] = useState<Record<string, string>>({});
  const [editScope, setEditScope] = useState<Record<string, string>>({});
  const [deactivateArmed, setDeactivateArmed] = useState(false);
  const [deactivateResult, setDeactivateResult] = useState("");

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

  useEffect(() => {
    if (!loading && !notAdmin && !error) void loadAccessRequests();
  }, [loading, notAdmin, error, loadAccessRequests]);

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
    try {
      await grantMembershipApi(grantTarget.trim(), [{ role: grantRole, scope: grantScope }]);
      setGrantTarget("");
      await loadMemberships();
    } catch (err: any) {
      setMembersError(err?.message || "Failed to grant membership.");
    } finally {
      setActingId(null);
    }
  }, [grantTarget, grantRole, grantScope, loadMemberships]);

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
      setDeactivateResult(
        report.verified
          ? "Deactivated: sessions, memberships, keys, and tokens revoked and verified."
          : `Deactivation completed with unverified items: ${report.residuals.join("; ") || "see report"}.`,
      );
    } catch (err: any) {
      setDeactivateResult(err?.message || "Failed to deactivate.");
    }
  }, [deactivateArmed]);

  const decide = useCallback(
    async (requestId: string, decision: "approve" | "deny") => {
      setDecidingId(requestId);
      setAccessError("");
      try {
        const updated = await decideAccessRequest(requestId, decision);
        setAccessRequests((prev) => prev.map((r) => (r.requestId === requestId ? updated : r)));
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

        {/* Issue #2501: service-user provisioning lives on Overview,
        not a new tab (tab indices unchanged) and not duplicated in
        the Queue tab: like admin counts and genesis, it is platform
        state. */}
        <h4>Service user</h4>
        <ServiceUserSection />

        {/* Issue #2681: service tokens live on Overview beside the
        service-user section, not a new tab (tab indices unchanged)
        and not duplicated elsewhere: like the service-user tiers,
        they are platform state. */}
        <h4>Service tokens</h4>
        <ServiceTokensPanel />

        <p className="iaaa-admin-note">
          Audit events are read-only. Pending access requests below can be
          approved or denied here; approval grants the requested role, denial grants nothing.
          Membership grant, revoke, and edit live on the Members tab.
        </p>

        <h4>Deactivate my account</h4>
        <p className="iaaa-admin-note">
          Deactivation revokes your sessions, memberships, API keys, and E*TRADE tokens,
          suppresses mail, and verifies the result. It cannot be undone from this panel.
          Click once to arm, again to confirm.
        </p>
        {deactivateResult && <Notice tone="danger">{deactivateResult}</Notice>}
        <Button type="button" onClick={() => void deactivate()}>
          {deactivateArmed ? "Confirm deactivation" : "Deactivate my account"}
        </Button>

        <h4>Access requests</h4>
        {accessError && <Notice tone="danger">{accessError}</Notice>}
        {accessRequests.length === 0 ? (
          <EmptyState title="No access requests" description="No elevation requests recorded for this tenant yet." />
        ) : (
          <Table
            columns={[
              { key: "requested", header: "Requested", render: (r) => formatEventTime(r.createdAtMs) },
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

        <h4>Recent audit events</h4>
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

      <TabPanel idBase="iaaa-admin" tabId="members" active={tab === "members"}>
        <p className="iaaa-admin-note">
          Memberships in this tenant (platform admins see all tenants&apos; memberships).
          Granting yourself a role is refused server-side; a grant requires fresh
          authentication for the step-up obligation, so a stale session must sign in again.
        </p>
        {membersError && <Notice tone="danger">{membersError}</Notice>}
        <h4>Grant membership</h4>
        <TextInput
          label="Target internal user id"
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
        <Button type="button" disabled={actingId === "grant"} onClick={() => void grant()}>
          Grant
        </Button>
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
      <TabPanel idBase="iaaa-admin" tabId="queue" active={tab === "queue"}>
        <AdminQueueWipePanel />
      </TabPanel>
    </div>
  );
}
