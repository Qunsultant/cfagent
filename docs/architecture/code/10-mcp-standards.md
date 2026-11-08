# 10 — MCP standards

**Purpose.** How MCP tools are added, named, organized, executed, and
catalogued. The scope and authorization rules for MCP tools are in `05` E6
(ADR 0012) and are not duplicated here; this file is the builder's
end-to-end rule for the tool itself.

**Canonical sources.** ADR 0012 (scopes — `05` E6),
`docs/architecture/agentic/mcp-server-inventory.md` (current, verified
against the live registry), `docs/architecture/security/mcp-security.md`,
`src/config/asyncJobModes.ts`.

**The surface at `9925ead8`.** `src/mcps/` holds 23 files: the `openaimp`
server, the `/mcp/scanner` x402 server, a public server, and a client. The
factory registry holds 118 tools.

**Adding a tool, end to end (the shape every rule below serves).** One
command class implementing `IMcpToolCommand` in a per-domain commands file
under `src/mcps/openaimp/` → one `this.registerTool(new XCommand())` line in
`McpToolFactory` → one entry in `MCP_TOOL_SCOPES` → the completeness pin
(`05` E6) fails until registry and scope table agree → the inventory
document is updated (its §7 verification method is a live `tools/list`
reconciliation).

## K1 — The four gate questions come before the tool

**Definition.** Before adding an MCP tool, answer, in the PR: (1) transport
or own gate — name the permission and the denial behaviour; (2) catalog
presence — or record the gap; (3) inherited gates — E*TRADE, keys,
memberships, audit; (4) attributability — calls are attributable to a
session or a key. A tool PR that does not answer all four is incomplete.
**Status.** DOCUMENTED — `mcp-security.md` §5. A checklist in a security
document today; no template or gate carries it.
**Conformance at `9925ead8`.** Process standard; measured by the inventory's
live reconciliation (K6), not by grep.

## K2 — Every tool is declared synchronous or queued

**Definition.** Every tool is explicitly declared synchronous or queued.
Only tools in `SYNCHRONOUS_MCP_TOOLS` return results inline; all others
return a `{ jobId, status: "queued" }` receipt, and results are retrieved
via `get_async_job` / `list_async_jobs`. An undeclared tool is a violation.
**Status.** ENFORCED — the sync set is a named, pinned list
(`src/config/asyncJobModes.ts`); the queued receipt shape is the factory's
behaviour.
**Conformance at `9925ead8`.** 7 synchronous, 109 queued, of 118 registered
tools. (The registry total reconciles as 109 canonical tools + 9 deprecated
aliases, per the inventory — K4.)

## K3 — One command class per tool, per-domain files, one factory

**Definition (as ruled, 2026-11-08).** Each tool is one command class. Under
the absolute one-class-per-file rule (`13` P1), each command class lives in
its own file, and those files are grouped in **per-domain directories**
under `src/mcps/openaimp/` — the domain-breakdown principle (README) applied
to the registry. All classes register in the single `McpToolFactory`; there
is no second registration path.
**Status.** ADOPTED-PENDING-IMPLEMENTATION for the file layout — the survey
found K3 documented-only with multi-class per-domain files as the structure,
and the ruling explicitly denies the registry pattern an exemption from P1.
The single-factory, no-second-path half is DOCUMENTED today
(`mcp-server-inventory.md` §§1–2) and already holds.
**Conformance at `9925ead8`.** Baseline: the multi-class command files are
P1 baseline rows — `meshDoorCommands.ts` 28 classes, `commands.ts` 18,
`marketDataCommands.ts` 12, `cloudflareAgentCommands.ts` 9 — shrink-only,
restructured by slice or cleared on touch. Nothing pins file placement for a
new command today; new commands conform to the ruled layout immediately.

## K4 — Tool names are `snake_case`, verb-first

**Definition.** Tool names are `snake_case` and verb-first (`get_*`,
`list_*`, `run_*`, `set_*`, `manage_*`, …). Dotted names and non-verb names
are violations.
**Status.** DOCUMENTED — ratified here from measured practice; no repo
document stated it before this set.
**Conformance at `9925ead8`.** Baseline: 116 of 118 tools conform. The 2
dotted names (`goal.compile`, `goal.schedule`) are baseline violations. The
deprecated `foss_*` alias family (9, counted inside the 118) is dispositioned
under `08`, not renamed by this standard.

## K5 — Transports accept session or API key, in that order

**Definition.** The MCP transports (`/mcp`, `/api/mcp`) accept a session or
an API key, nothing else, in that fallback order. The fallback is a security
decision and is kept out of any framework adapter. `/mcp/scanner` is the one
designed exception: x402 payment is its gate.
**Status.** DOCUMENTED — `mcp-security.md` §§1, 3. Implemented in Worker
dispatch; no conformance pin drives the real dispatch for MCP auth (by
contrast, A2A has one — `tests/a2a_entrypoint_auth_1763.test.ts`).
**Conformance at `9925ead8`.** Per the dispatch implementation; unpinned.

## K6 — The published catalog is not the inventory; absences are reported

**Definition.** The published catalog is public knowledge and is *not* the
inventory: an absent tool may still be callable, and a listed tool may be
gated. Known absences are reported as gaps — never silently filled with
unverified entries.
**Status.** DOCUMENTED — `mcp-security.md` §2.
**Conformance at `9925ead8`.** 18 MCP absences are reported by the IAAA
panel (4 scanner tools + 14 command classes). Measurement for K1/K3/K6 is
the inventory's live `tools/list` reconciliation, repeated at census time —
not a grep count.
