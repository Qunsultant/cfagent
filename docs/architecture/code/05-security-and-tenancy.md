# 05 — Security and tenancy

**Purpose.** Authorization, tenant isolation, agent authority, secrets, MCP
tool scopes, and the human-approval and step-cap rules for autonomous
execution.

**Canonical sources.** `docs/agents/tech-standards.md` §§5–6,
`docs/compliance/anti-drift.md` (§§1E, 2), ADR 0012 (MCP scopes),
`docs/architecture/standards/standards.md` §§6.1/6.4, the repository
`.gitleaks.toml`.

## E1 — Authorization is server-side, through the central PDP seam

**Definition.** Every authorization decision is enforced server-side through
the central PDP seam (`iaaaPdpSeam.ts`). An endpoint that makes its own
ad-hoc authorization decision beside the seam is a violation; a bypassed PDP
seam is named drift in `anti-drift.md` §1E.
**Status.** DOCUMENTED — no pin forces a route's authorization through the
seam.
**Conformance at `9925ead8`.** Not mechanically measured.

## E2 — Tenant isolation, with negative tests

**Definition.** Tenant isolation is enforced across every surface a tenant's
data can touch: database, object storage, search/vector, caches, queues,
agent state, conversations, artifacts, integrations, notifications, logs,
and exports. Every cross-tenant access path carries negative tests — a test
that a tenant cannot reach another tenant's data through that path.
**Status.** DOCUMENTED — `docs/agents/tech-standards.md` §6.
**Conformance at `9925ead8`.** Not measured as a single figure; the negative-
test requirement is discharged per surface and is part of the agentic test
list in `07` G9.

## E3 — Agent authority is an intersection, rechecked before execution

**Definition.** An agent acts only on the intersection of: user authority ∩
organization policy ∩ resource policy ∩ tool policy ∩ current approval.
Authorization is rechecked before consequential execution, not only at
session start.
**Status.** DOCUMENTED — `docs/agents/tech-standards.md` §6 ("Delegated agent
authority").
**Conformance at `9925ead8`.** Relied on by the agent lifecycle standard in
`15` (R8); not mechanically measured.

## E4 — Established libraries; no custom cryptography

**Definition.** Prefer established libraries over custom security mechanisms.
Never implement custom cryptographic algorithms. Verify signatures in
constant time.
**Status.** DOCUMENTED — `docs/agents/tech-standards.md` §5;
`anti-drift.md` §2 (constant-time HMAC in `src/security/session.ts`).
**Conformance at `9925ead8`.** Not mechanically measured.

## E5 — Secrets never appear in code, logs, or URLs

**Definition.** No secret appears in code, in a log line, or in a URL. Secret
scanning covers the **full PR commit range**, not the final tree: a
secret-shaped string introduced in any branch commit fails the scan even if
a later commit removes it. Test fixtures that must contain secret-shaped
values follow the fragment-assembly rule in `08` H9.
**Status.** ENFORCED — Gitleaks secret scan, a required check
(`.github/workflows/gitleaks.yml`).
**Conformance at `9925ead8`.** Gate green at base.

## E6 — Every MCP tool carries exactly one scope, completeness-pinned

**Definition.** Every MCP tool carries exactly one scope from the six-scope
set (`mcp:read` / `mcp:write` / `mcp:execute` / `mcp:trade` / `mcp:payments` /
`mcp:admin`), scoped to its most privileged action. Authorization is checked
at every choke point: the factory, the JSON-RPC path, and the agent-turn
adapter. The tool declaration table is completeness-pinned against the live
registry in both directions — a tool without a scope row fails, and a scope
row without a tool fails.
**Status.** ENFORCED — ADR 0012 completeness pin against the live factory
registry; `tests/tool_attribution_audit_1763.test.ts` additionally pins that
the audit document names every factory tool (120) and scanner tool (4).
**Conformance at `9925ead8`.** Registry↔scope completeness 118/118 per the
MCP inventory (`10` K-area measures the registry itself). The end-to-end rule
for adding a tool is in `10`.

## E7 — HITL for consequential actions; deterministic caps for loops

**Definition.** High-impact and consequential actions pause for explicit
human approval before execution. Autonomous loops run under deterministic
step caps (`MAS_MAX_STEPS`, default 6, clamped 1–10) and per-step timeouts.
A loop without a cap, or a consequential action that executes without the
approval pause, is a violation.
**Status.** DOCUMENTED — `docs/architecture/standards/standards.md`
§§6.1/6.4; `anti-drift.md` §2.
**Conformance at `9925ead8`.** The caps exist in code; the cost-governance
statement that joins caps, meters, and at-cap behaviour is in `15` (R6).

## E8 — Session tokens live in SQLite Durable Objects, never unencrypted KV

**Definition.** Session tokens are stored in SQLite Durable Objects
(`src/security/sessionStore.ts`). Session tokens are never stored in
unencrypted KV.
**Status.** DOCUMENTED — `anti-drift.md` §2 ("Zero KV Security Dependency").
**Conformance at `9925ead8`.** Per the session store implementation; not
separately pinned.
