# Agent access management (#2171, parent #1717)

Parent program: #1717. Slice issue: #2171 (agent-subject slice of
the IAAA epic #945; CTO-lane #945 implementation itself is NOT
built here). Implementation: `src/security/agentAccess.ts`
(identity, grant, enforcement, revocation, audit), the optional
`agentAccess` option on the MCP permission gate
(`src/mcps/openaimp/mcpPermissionPorts.ts`), and its threading
through `McpAgentToolAdapter` / `McpToolContext`.

## 1. Agent identity

An agent id is `agent:<kind>:<slug>` where kind is one of
`fleet | a2a | mcp | scheduled | service`. The namespace cannot
collide with a user id (user ids are UUIDs, `v1:` hashes, or
`service:<login>`). The id is stable across runs and distinct from
the user the agent acts for. A service principal's agent id derives
from its service login (`agent:service:<login>`, from the same login
whose internal id is `service:<login>` per #2681) — never a second
derivation, never a shared-secret fallback.

An identity records, when present: its tenant binding, the
delegating principal's internal user id, and the delegation backing
it. Delegation is bounded at creation (the delegator must hold each
delegated permission in the tenant, via the PDP — see
`delegation.ts`) and re-checked at every invocation (never assumed
from creation). Re-delegation stays bounded by the original grant
(actions, scope, expiry, remaining budget).

## 2. Grant model

A grant names exactly one target — a tool name, a route pattern, an
agent id, or a data scope — in exactly one tenant, optionally
bounded by purpose, resource scope, expiry, and an action-count
budget, and optionally backed by a delegation. Matching is EXACT:
the target string must equal the grant's target, and a
purpose-bound grant requires exactly that purpose. Grants are
default-deny: no matching grant, no access, and no single factor
ever grants. A permission-bearing grant additionally requires a PDP
allow for the delegating principal (or the agent id when no
principal is recorded); a permission-less grant is governed by the
grant + delegation checks alone and no PDP is consulted for it.

## 3. Enforcement points (implemented)

Enforcement runs through `authorizeAgentInvocation()`, in fixed
order, first deny wins: identity → grant → delegation → PDP →
obligations (opt-in) → audit → budget persist. A PDP error, a
missing PDP for a permission-bearing grant, a missing delegation
store for a delegation-backed grant, and a failing allow-audit all
deny (fail-closed). A deny audit that fails never changes the deny.

| Invocation point | Status in this slice |
|---|---|
| MCP tool gate (`authorizeMcpToolCall` / `executeWithPermissionGate`, incl. the queued path's authorize-before-submit) | Enforced when the call site supplies `agentAccess` and the mode is `enforce`. The scope check always runs first; a scope denial keeps its own audit and never reaches the agent check. |
| Agent-turn adapter (`McpAgentToolAdapter`) | Enforced when the turn context carries `agentAccess` (threaded through `McpToolContext.agentAccess`). This is the G-AUD-2 door: the turn's agent identity, not a null-login `agent-turn` principal, is the subject of the check. |
| Scheduled runs | Inherit the factory-gate point: a scheduled run's tool calls pass the same gate. The run executor does not yet supply agent context (same pattern as the #2341 `actingLogin` stamping), so scheduled enforcement activates when the executor wires the run's agent context — a named residual, not a silent claim. |
| A2A dispatch (`POST /a2a/*`) | NOT changed. The shared `A2A_API_TOKEN` gate stays exactly as #2053 governs it (aliasing token names is forbidden there). Agent grants apply to A2A only once #945 wiring resolves an A2A caller to an agent identity, which does not exist today (G-AUD-6). |

## 4. Enforcement mode (platform-only switch)

`IAAA_AGENT_ACCESS_MODE`, read ONLY from the platform env by the
gate's caller (there is no run, session, or user carrier for it, so
a gated subject cannot configure away its own enforcement):

| Value | Behavior |
|---|---|
| unset / blank / `off` (default) | No agent check, no agent audit. Live gates unchanged at merge. |
| `audit` | Shadow: the gate evaluates and audits would-deny as `agent.access_shadow_denied`, but never denies. |
| `enforce` | A grant denial audits as `agent.access_denied` and throws the same `FAILURE_MCP_PERMISSION_DENIED` business error as a scope denial, before execution begins. A grant allow audits as `agent.action`. |
| anything else | `off` with `invalid=true` — visible misconfiguration, never a silent upgrade to enforce. The caller must log/audit the invalid flag. |

Launch state is deliberately `off` with no production caller
supplying `agentAccess` yet: no identities or grants are
provisioned in production, so default-enforce would deny every
agent-turn call. Activation is a platform/owner step (provision
identities + grants, wire a context owner to supply them, set the
switch) — it is NOT set by this slice, and no production switch
value is touched here.

## 5. Revocation propagation bounds

Measurement follows #1750 (clock starts when the revoking write
completes; 0 ms means the very next gate check denies). This module
caches nothing, so every check is a fresh store read:

| Trigger | Bound | Mechanism |
|---|---|---|
| Grant revocation | 0 ms | Next `authorizeAgentInvocation` denies (`GRANT_REVOKED`). |
| Identity revocation | 0 ms | Next check denies (`IDENTITY_REVOKED`); the cascade revoking the identity's grants runs in the same operation as belt-and-braces — the bound does not depend on it. |
| Delegation revocation | 0 ms | Next check denies (`DELEGATION_REVOKED`) because the delegation store is re-read every call, even when its grants are left untouched. |
| Expiry (identity or grant) | 0 ms past the deadline | Exclusive boundary: a check at `expiresAtMs` denies. |
| Budget exhaustion | Immediate | `usedActions` is persisted by the gate on allow; the next call at the cap denies (`BUDGET_EXHAUSTED`). |

In-flight work is DEFINED: a decision already returned is never
retroactively killed. A started execution keeps its seal; its next
tool invocation re-authorizes and denies. A scheduled run already
executing runs to completion; its next invocation denies. A gate
that caches identity/grant records must state its cache TTL as its
own bound — it is not folded into the numbers above.

## 6. Audit

Every covered decision produces one `agent.action` record (via the
caller's sink; at the MCP gate, allows audit as `agent.action`,
enforce-denials as `agent.access_denied`, shadow-denials as
`agent.access_shadow_denied`) carrying: agent id + kind, grant id
(null when no grant matched), delegating principal (identity
principal, else delegation delegator, else null), tenant, target
kind + target, purpose, resource id, decision, reason, timestamp.
An allow is returned only after its audit write succeeds
(`AUDIT_FAILED` otherwise, persisting nothing) — audit as a
condition, mirroring #1751. This is the uniform allowed-call audit
row G-AUD-1 asked for, for calls routed through a gate supplied
with agent context. The #1760 hash-chained store is the sink the
adopting route supplies; this module performs no I/O itself.

## 7. Paths still on a shared token or synthetic identity (stated, not hidden)

- A2A dispatch: shared `A2A_API_TOKEN` (fleet identity, not
  per-caller) — unchanged, #2053 territory; G-AUD-6 carried.
- Scanner free tools (`scanner_status`, job reads): intentionally
  unauthenticated by design (#1763 G-AUD-4/G-AUD-5) — unchanged.
- In-process `system` callers: route-attributable only (G-AUD-3) —
  unchanged until route-login threading lands.
- Service-token callers at the MCP gate: mapped to `unknown`
  (deny-all scopes) since #2681 — unchanged.
- Any MCP/agent-turn call whose context carries no `agentAccess`:
  scope-gated only, exactly as before — the agent check is
  opt-in per call site, so no existing caller changes behavior
  at merge.

## 8. Residuals (carried with reason)

- R1 — Durable provisioning + SessionStore-bucket wiring for
  identities/grants: the store interfaces + KvLike adapter are the
  port; the bucket and provisioning UX belong to CTO-lane #945
  adoption, which owns that store. This slice invents no second
  bucket.
- R2 — Scheduled-run executor agent context (see §3).
- R3 — A2A per-caller agent identity (G-AUD-6, #945 wiring).
- R4 — System-principal login threading (G-AUD-3) and scanner
  isolation (G-AUD-4/G-AUD-5): out of this slice's scope, recorded
  in #1763.
- R5 — Human role/membership UI (#2688): untouched except where
  agent delegation touches it (delegator-holds-permission rule).
- R6 — Production activation (provisioning + switch): owner /
  platform action, never set by this slice.

## 9. Configurability note (NEVER EITHER/OR)

There is no divergent pair to keep behind a switch here: the
scope gate and the agent-grant gate compose (scope first, then
grant), and neither replaces the other. The mode switch (§4)
governs only the new grant gate's effect (off / shadow /
enforce); it never disables the scope gate, and no value lets a
caller disable their own enforcement. The old scope-only behavior
is preserved exactly as the `agentAccess`-absent path, not as a
second contract to be deleted later.

#CISO-bhdm
