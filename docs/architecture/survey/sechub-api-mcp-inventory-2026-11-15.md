# SecHub API / MCP inventory for the security agent build (#3114)

Verified against Qunsultant/cfagent origin/main `fcd96a2f`, 2026-11-15 ~17:45 EST.
Read-only source: panels under `src/client/`, routes in `src/server/routes/auth.ts`,
MCP tools under `src/mcps/openaimp/`, scope map in `src/mcps/openaimp/mcpPermissionPorts.ts`.

## Status of the four policy tabs

| Tab | View | State | What you can do on it |
|---|---|---|---|
| PDP | `?tab=security-hub&view=pdp` | LIVE (#4651, PR #4678 merged) | Read-only. See active policy (version, compiled vs PAP-promoted source, role→permission grants), resolved policy source (code\|snapshot + invalid fail-closed warning), frozen OBLIGATION_POLICY + evaluateWithObligations() coverage per permission (enforced: role:assign, membership:revoke; residual: audit:export). No edit control. |
| PEP | `?tab=security-hub&view=pep` | LIVE (#4653 merged) | Read-only. See enforcement state for your session (on/off, PDP flag, wired vs legacy session, legacy grace window), gated-routes inventory (method, route, permission, gateway, denial response), recent decisions — honest empty state, no record exists yet (gap #4683, sub-issue under #4653). No enforcement change lives here. |
| PIP | `?tab=security-hub&view=pip` | LIVE (#4655 merged) | Read-only. See attribute schema (Membership / RoleBinding / PermissionDenial fields), attribute sources (membership store via membershipStoreToAttributeProvider; KV denial store), and YOUR OWN attributes as the live AttributeProvider resolves them. No lookup of another user's attributes (gap #4661, sub-issue under #4655). |
| PAP | `?tab=security-hub&view=pap` | NOT BUILT (#4658, last in queue) | No tab yet. The PAP itself is the policy-proposals flow on IAAA Admin Overview (PolicyProposalsPanel). The tab, when built, surfaces that flow. Frozen OBLIGATION_POLICY edit scope is UNDECIDED (#2838 carry) — the PAP editor does not edit it. |

## REST endpoints the tabs use

- `GET /api/iaaa/policy-proposals/active` — active policy snapshot + source (existing, #2838). Used by PDP tab.
- `GET /api/security/pdp` — resolved policy source + frozen obligations + coverage (new, #4651). Platform-admin only; non-platform caller refused 403 + audited (`iaaa.policy`, `policy.access_denied`, `PDP_FORBIDDEN`). GET only (405 otherwise). No snapshot JSON returned.
- `GET /api/security/pep` — enforcement state for the caller's session + PEP_GATE_INVENTORY + decisionsAvailable:false / decisions:null (new, #4653). Platform-admin only, same deny-audit shape.
- `GET /api/security/pip` — attribute schema + sources + caller's own resolved attributes (new, #4655). Same gating pattern.

## REST endpoints for the PAP flow (write-capable, used by IAAA Admin Overview today)

- `GET /api/iaaa/policy-proposals`, `GET /api/iaaa/policy-proposals/active`
- `POST /api/iaaa/policy-proposals/propose` / `approve` / `reject` / `promote` / `preview`
- `POST /api/iaaa/bootstrap-proposals/propose` / `approve` / `reject` / `confirm-applied` (+ `GET .../bootstrap-proposals`, `.../current`)

## Other SecHub write-capable REST (the "all SecHub operations" surface)

IAAA Admin (`?tab=security-hub&view=iaaa-admin`, IaaaAdminPanel):
- `POST /api/iaaa/membership/grant` | `revoke` | `edit`
- `POST /api/iaaa/role-grants/grant` | `revoke` (+ `GET /api/iaaa/role-grants`)
- `POST /api/iaaa/permission/deny` | `clear`
- `POST /api/iaaa/logged-in-users/revoke` (+ `GET /api/iaaa/logged-in-users`)
- `POST /api/iaaa/access-request` | `/api/iaaa/access-request/decision` (+ `GET /api/iaaa/access-requests`)
- `POST /api/iaaa/deactivate` | `offboard`
- `POST /api/iaaa/quota-usage/override` (+ `GET /api/iaaa/quota-usage`)
- `GET /api/iaaa/overview`, `GET /api/iaaa/memberships`

Service tokens (IAAA Admin → Service tokens, #2681):
- `POST /api/admin/service-user/provision`, `/api/admin/service-user/tokens`, `/tokens/rotate`, `/tokens/revoke`
- `GET /api/admin/service-user/status`

Users tab (UserAdminPanel): `GET /api/admin/platform-users/me`, `GET /api/admin/platform-users/lookup?login=` (lookup + self view; no write mutations found in the panel).

Admin-access tab (AdminAccessSection): request admin access via `POST /api/iaaa/access-request`; decisions via `POST /api/iaaa/access-request/decision`.

Profile tab (ProfileSection): your display name and phone (self view).

## MCP endpoints: NONE for any of this

- No MCP tool exposes PDP, PEP, PIP, PAP, membership, role grants, sessions, service tokens, or any other SecHub operation. The earlier #3114 verification stands: no agent/MCP tool exposes admin actions.
- The only `mcp:admin`-scoped tools are generic reads: `get_audit_events`, `list_database_tables`, `query_table_data`, `get_revenue_summary` (`src/mcps/openaimp/mcpPermissionPorts.ts`, scope map).
- MCP mentions of IAAA/policy in `src/mcps/` are incidental (tenant resolution via `resolveIaaaTenant`, scope comments) — no admin tool exists.

## What the security agent build (#3114) needs

1. **Slice 1 — agent tool surface**: new MCP tools wrapping the REST routes above (reads first: the three `/api/security/*` GETs + policy-proposals reads; then the write routes, one at a time under the #3114 guardrails).
2. **Guardrails (standing, #3114)**: PDP-enforced fail-closed; Q4 step-up windows; agent never grants itself privilege, never disables its own enforcement; proposer ≠ approver (single-admin self-approval only with named reason + audit); durable granter-attributed audit, audit-before-persist; agent calls the same session-gated routes the panels call.
3. **Calling identity — DECIDED by the owner 2026-11-15 (refined same day)**: the agent acts **session-gated under the acting admin's scope — platform-admin for platform-level security, tenant-admin for tenant-level security** — it performs SecHub operations as the signed-in admin through their session, not as a service identity (svc_token, #2681). Consequences: scope follows the operation and the session's grants, resolved fail-closed through the PDP for every action — a tenant-admin session can drive tenant-level operations in its tenant but cannot reach platform-level state (the PDP/PEP/PIP endpoints stay platform-admin-only); the agent inherits Q4 step-up windows, proposer ≠ approver, and audit attribution to that admin; it cannot act without a live admin session. The per-route scope matrix (which operations are platform-level vs tenant-level) is part of the slice-1 tool-surface design. This does not decide Q10 in full (service/workload identity remains open) and does not remove the #1066 gap for background workloads, which still have no authorization path.
4. **Coordination**: #3748 (MCP server scoping/security/tool gaps, filed by another lane) needs coordination with this lane before it starts.
5. **Known gaps to close or carry**: #4683 (PEP decision record does not exist), #4661 (no admin lookup of another user's attributes), #2838 carry (frozen OBLIGATION_POLICY edit scope undecided).
