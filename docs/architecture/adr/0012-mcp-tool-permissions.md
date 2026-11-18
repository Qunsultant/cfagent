# ADR 0012: MCP tool permissions — per-tool scopes + cryptographic execution isolation

- Status: Accepted
- Issue: #1744 (sub-issue of #1736, item 8)
- Supersedes: nothing (consumes ADR 0011 observability stream for denial events, #1739 CloudEvents discipline for event shape, #945 IAAA identity as consumed — never duplicated)
- Related: `docs/architecture/code/aop-fit-gap-analysis.md` Tool/MCP Governance 72 (schema validation present, runtime tool allowlist policy aspect missing; `@AuthorizeTool` shape); #1717 MCP/A2A #1763 (invocation-auth verification, scanner attribution, prompt-gate wiring, stable error tokens); #1717 SCOPED DEFAULTS rule (default = current public behavior, recorded explicitly so the owner can overturn)

## Context

MCP tools were gated only at the session/route level: once a
caller held an app session or a per-user `cfk_` API key, every
registered tool was invocable, and nothing separated one tool
execution from another. A compromised or over-privileged caller
could invoke tools beyond its need, and a forged argument could
not be distinguished from a legitimate one at the tool layer.
The registry itself (`McpToolFactory`, 51 tools) had no scope
model at all, and two execution paths bypassed the factory
entirely: the agent-turn adapter (`McpAgentToolAdapter`) calls
`command.execute` directly, as do its `rememberFact` /
`recallFacts` helpers — so gating only the factory would have
left the model-driven path, the highest-risk caller class,
outside the permission model.

## Decision

Port-first permissions in `src/permissions/`, behind one port
with two adapters and a conformance suite run unchanged
against both:

- **Port** (`mcpPermissionPorts.ts`): six scopes
  (`mcp:read`, `mcp:write`, `mcp:execute`, `mcp:trade`,
  `mcp:payments`, `mcp:admin`); one scope per tool, chosen by
  what the tool DOES (per-tool, not per-action: a tool is
  scoped to its most privileged action, so `manage_session_memory`
  is `mcp:write` even for its list action); the full 51-tool
  declaration table, completeness-pinned against the live
  factory registry in both directions; `authorize` before
  execution; `beginExecution` / `openExecution` /
  `endExecution` isolation (see below).
- **Production adapter**: static default policy. **In-memory
  adapter**: explicit per-principal overrides over the same
  defaults — the seam a future IAAA role→scope adapter plugs
  into, and the mechanism tests use for restricted principals.
  Adapters differ ONLY in scope resolution; isolation
  mechanics live in the shared `executionStore.ts`, so the
  isolation contract holds identically behind any adapter.
- **Gate** (`executeWithPermissionGate`): authorize → deny
  throws before `run` is invoked; allow begins a sealed
  execution and destroys its seal in a `finally` block.
  `authorizeMcpToolCall` alone covers the queue-before-execute
  branches (a refused call never receives a job receipt).

## Scope assignment: the explicit default

The default assignment is current behavior, per #1717 SCOPED
DEFAULTS: `system`, `session`, `api-key`, and `agent-turn`
principals hold every scope, so no legitimate call changes
behavior at launch. The one non-default assignment:
`scanner-payment` holds only `mcp:payments` (the paid-tool
entitlement); `unknown` holds nothing and is always denied.
This default is recorded here so the owner can overturn it
(e.g. restrict api-key principals to read scopes) by changing
one adapter table — never the gate, never a call site.

Why not role-differentiated assignments at launch: resolving a
login to IAAA role bindings at the SearchAgent DO tool-call
site does not exist in #945's consumed surface today (the PDP
in `src/security/authorization.ts` is pure policy over
membership inputs; memberships are keyed by internalUserId,
and the DO tool path carries only the forwarded login).
Building that resolution here would duplicate §1 identity work
belonging to the CISO lane. It is a follow-up for that lane:
expose login→internalUserId→membership resolution consumable
from the DO tool path, and the production adapter maps PDP
role grants to MCP scopes. Until then, the enforcement point,
the declarations, and the isolation are live for every call,
and the assignment is the recorded default above.

## Principals and header threading

The Worker `/mcp` route already authenticates (401 without a
session or valid key) and forwards `x-user-login` to the
SearchAgent DO; this slice adds `x-principal-kind`
(`session` | `api-key`) to that forward, and the DO's `/mcp`
POST handler resolves the principal from those headers
(`resolveMcpPrincipalFromHeaders`). A missing login resolves
to `unknown` — fail closed, never defaulted to system. Only
in-process platform callers use the system default (REST
bridge, job executor, whose route layers already
authenticated), and agent turns use kind `agent-turn` (the
turn runs inside the owner's own agent instance, so the
instance boundary IS the identity boundary; threading the
turn's userLogin into the principal is a follow-up for finer
audit attribution). Scopes never come from tool-call
arguments: a forged `scope` argument is ignored (pinned by
test), the same pattern as slice-4's forged-tenant rule.

## Cryptographic execution isolation

Each execution gets a fresh 256-bit random key (via
`crypto.getRandomValues`) and a random id. The key is held
ONLY by the gate — it never enters tool arguments, tool
context (only the execution id does, for correlation), audit
payloads, or stream events. Opening a record requires the
exact key under a constant-time compare; any other key, any
other execution's key, or an unknown id opens nothing; ending
with the exact key destroys the record, and afterwards even
the right key opens nothing. Records are per-isolate and
short-lived (created and destroyed inside one gated
execution). Honest boundary: this is execution-CONTEXT
isolation at the gate layer, exactly the issue's
"per-execution keys/context separation" — NOT process/memory
isolation between tools, which is the Workers runtime's job,
and NOT a rewrite of every tool's internals (tool semantics
and results are untouched, per the issue's exclusion).

## Denial contract

A refused call returns a business error, never a technical
leak: `BusinessError` code `MCP_001` (catalog entry added;
the JSON-RPC layer renders `[MCP_001] ` + business message).
It is audit-logged as `mcp.permission_denied` (durable trail,
with tool, required scope, principal kind, and the
authenticated login for review) and streamed as a
`mcp.permission_denied` event via #1743's port (counts and
outcomes only: tool, scope, kind, session correlator — never
arguments, never login material beyond the correlator).
Allows are not streamed (volume: every chat-turn tool call
would flood the stream; the HTTP boundary already streams
`http.request`). Sink failure never changes a decision.
Unknown tools keep the pre-existing not-registered error:
lookup precedes the gate (pinned by
`tests/rest_mcp_commands_p1644.test.ts`).

## Choke points (all gated, none bypassable in-process)

- `McpToolFactory.executeTool` (JSON-RPC sync path, REST
  bridge, job executor).
- `handleMCPRequest` tools/call queued path (authorize
  before `submitJob`).
- `McpAgentToolAdapter.adapt` + `rememberFact` /
  `recallFacts` (agent turns, both delivery branches).
- `executeMCPTool` (builds the #1743 sink from env when the
  caller supplied none; principal/port flow through).

## Boundaries (consumed or linked, never duplicated)

- #945 / IAAA: session auth, `requireAuth`, and the PDP are
  consumed as-is; no new identity system, principal resolver,
  or session store is built here.
- #1763 (CISO lane, open): invocation-auth verification,
  scanner attribution, prompt-gate wiring, and A2A-wide
  stable error tokens. This slice uses one stable token
  (`MCP_001`) for its own denials, which aligns with — but
  does not implement — #1763's token work. The `/mcp/scanner`
  DO path is separate (payment-gated, its own instance) and
  is untouched; scanner-payment scope exists in the port for
  its future wiring.
- #1743 observability: denial events use its sink and event
  shape; no new stream, no new tables, no new routes, no
  IAAA change.
- #1738 actor port: actors are callers through the adapter,
  not a second gate; the actor port itself is untouched.
- Out of scope (follow-ups, not absorbed): `chain.run`
  execution binding (its scope is declared, its semantics
  untouched); AOP Phases 3–4; tenant-isolation enforcement
  (§1, CISO #945); error-catalog conversion beyond `MCP_001`;
  scheduled-screen cutover; work-queue consumer + DLQ wiring;
  #1078 enforcement flip; seed invokes + #1546 closure;
  champion/challenger gate; dashboard UI for decisions (the
  observability stream is the queryable surface); threading
  turn userLogin into the agent-turn principal; threading
  the decision sink into REST-bridge calls.

## Dynamic registration (factory OCP, preserved)

The factory promises runtime extensibility
(`registerTool`), and the gate must not break it: a
dynamically registered tool with no scope would otherwise be
denied forever. So `registerTool(command, scope?)` accepts an
optional scope, declared via `declareToolScope` into a
port-level overlay consulted before the static table — and
static declarations are immutable: declaring a scope for a
statically declared tool throws, so runtime code can never
weaken a sensitive tool's scope (re-registering a static
tool's implementation keeps its static scope, since the gate
resolves scope by NAME). The OCP test pins this end to end
(`custom_audit_report` registers with `mcp:read` and executes
through the adapter).

## Consequences

- Every future tool must declare a scope or the
  completeness test fails and the gate denies it — new
  capabilities cannot silently arrive unscoped.
- The owner can tighten interactive assignments by editing
  one adapter table; the CISO lane can replace the
  production adapter with a PDP-backed one without touching
  the gate or any call site.
- Denied calls are visible in two places (audit trail +
  observability stream) with no argument or credential
  material in either.

## Amendment — GAP-4: the role→scope adapter is plugged in (2026-11-18)

GAP-4 (#5468, design #5343 / ADR 0034, CISO coordination
#5350) plugs the IAAA role→scope adapter into the seam this
ADR left future (`resolveScopesWithRoleAdapter` +
`scopesForIaaaRoles` in `mcpPermissionPorts.ts`): scopes
derive from IAAA roles through a permission correspondence
read off the compiled policy snapshot, with the
`scanner-payment` pin (`mcp:payments` only) and the `unknown`
deny expressed through the adapter. The correspondence is a
proposal put to CISO review, not a CISO decision. The
follow-up this ADR names — login→internalUserId→membership
resolution consumable from the DO tool path — is still open:
no gate call site supplies a role resolver yet, so the
recorded defaults remain wherever the adapter cannot derive,
stated explicitly in the module header. The gate, the
declarations, and the isolation mechanics are untouched.
