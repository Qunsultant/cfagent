# 04 — Resolvers and context

**Purpose.** The resolver standard — one resolver per question, one typed
input, declared I/O, declared fallback — and the context and identity
resolution rules it sits beside.

**Canonical sources.** Issue #3786 (resolver consistency census + standard;
this file is that issue's standard deliverable, pulled forward into this
set), `docs/agents/tech-standards.md` §6, ADR 0001 (derived identity),
`src/security/executionContext.ts` (#1069 §8, via #1078).

**Scope note.** "Resolver" here means the tree's `resolve*` function family:
any deterministic derivation of an answer from context, configuration, or
stored state. The reference shape is the tenant pair —
`resolveTenantProviders` (async, reads the store) feeding
`resolveTenantProviderContext` (sync, normalizes the row).

## D1 — One resolver per question

**Definition.** Within one question there is exactly one resolver. Every
other place that derives the same answer calls it, or is deleted, or is
reduced to a delegating wrapper. A second, independent derivation of the
same answer is a violation. (Precedent: the `runDetails` resolver survives
only as a deprecated wrapper delegating to the canonical resolver in
`outcomeAspects.ts`.)
**Status.** DOCUMENTED — agreed 2026-11-08; issue #3786. Enforcement (census
+ shrink-only pin) belongs to #3786 and has not landed.
**Conformance at `9925ead8`.** Baseline: 251 exported `resolve*` signatures,
236 distinct names, in 164 files, plus 75 non-exported declarations —
duplicate-question derivations are inside that count and are dispositioned by
the #3786 census, shrink-only, cleared on touch. The config-modes family (62
of the signatures, `src/config/*Modes.ts`) is internally consistent and is
the conformance reference, not a rewrite target.

## D2 — Single typed input object; the envelope trust rule

**Definition.** A resolver takes one typed input object — not positional
parameters. For the context family, that object is the shared envelope
(tenant, login, environment, stored selections, provenance where present).
The envelope's fields split in two: *claims* (a selected provider id, a
timeframe, a requested cadence) are read directly; *authority-bearing fields*
(tenant identity, entitlements, approvals) are never trusted from the bag —
the envelope carries pointers ("tenant: from session", "selection: from
tenant store") and the resolver re-derives the fact from its authoritative
source at call time. The input says where to look, never what the answer is.
**Status.** DOCUMENTED — agreed 2026-11-08; issue #3786.
**Conformance at `9925ead8`.** Baseline: of 248 parseable exported
signatures, about 81 take a single typed parameter; the rest take two to
seven positional parameters (70 take 2, 53 take 3, 26 take 4, 12 take 5).
First-argument vocabulary is split (`env` 71, raw `string` 113, `unknown`
64, `input` 23, `deps` 10, `ctx`/`context` 7). Only six bespoke `Resolve*Input`
interfaces exist tree-wide; no shared envelope exists yet. Shrink-only under
#3786, cleared on touch.

## D3 — Sync if pure; async only for the resolver's own I/O

**Definition.** A resolver is synchronous when it is a pure derivation over
data already in hand. It is asynchronous only when it itself crosses an I/O
boundary. `async` marks exactly one thing: this function does its own I/O.
The I/O locus is declared in the resolver's header — **fat** (takes `env` or
ports and does its own reads) or **thin** (pure over an already-read input or
injected ports).
**Status.** DOCUMENTED — agreed 2026-11-08; issue #3786.
**Conformance at `9925ead8`.** This is the one axis the tree already holds:
all 38 async exported resolvers await real I/O (store/port/KV reads,
`crypto.subtle.digest`, provider calls), and the 210 synchronous resolvers
are pure derivations. The header declaration of fat/thin is new; the
sync/async discipline itself conforms.

## D4 — Fallback is declared and typed, never silent substitution

**Definition.** A resolver's fallback behaviour is part of its contract and
visible in its return: a fell-back flag, a `null`, or a typed refusal. A
resolver never silently substitutes a default answer for a missing fact.
**Status.** DOCUMENTED — agreed 2026-11-08; issue #3786.
**Conformance at `9925ead8`.** Baseline: fallback semantics diverge per
module — fail-open-to-legacy, fail-open-with-flags, return-null, fail-closed,
and route-503 all exist in the tree. Those five are the census's disposition
list for existing code, not a menu for new code: new resolvers declare one
behaviour under this standard, and existing ones conform by slice or on
touch.

## D5 — Tenant identity is resolved server-side from the session

**Definition.** Tenant identity is resolved server-side from the
authenticated session (practised via `resolveIaaaTenant`). A client-supplied
tenant identifier is never sufficient authority and is never the source of a
tenant fact.
**Status.** DOCUMENTED — `docs/agents/tech-standards.md` §6;
`src/services/tenantProviders.ts` header ("never from a client value").
**Conformance at `9925ead8`.** Practised at the resolution sites; no pin
asserts it per route.

## D6 — ExecutionContext is validated, frozen, fail-closed, ids-only

**Definition.** `ExecutionContext` is a validated, frozen, fail-closed
contract carrying identifiers only (tenant, workspace, principals, task/run/
delegation ids, connection, environment, policy and approval references) —
never presentation data. A context crossing a boundary is re-parsed and
revalidated at the point of use. Client-supplied identifiers inside it are
requests to be checked, never facts. Provider or presentation identity does
not go into ExecutionContext; it resolves from tenant context and registry
declarations beside it.
**Status.** DOCUMENTED — `src/security/executionContext.ts` (#1069 §8, via
#1078). The contract is code; this file is the first document to state it as
a standard. Its observe-mode default (enforcement flip is separate, under
#1078) is a code fact recorded here so a reader can learn it from the docs.
**Conformance at `9925ead8`.** Two production files touch ExecutionContext
at base; the contract itself is implemented as defined.

## D7 — Internal user identity is derived, never invented

**Definition.** An internal user identity is derived, never invented:
`v1:` + SHA-256 over (issuer, subject), with trim-only normalization — no
case folding, no URL canonicalization. Any other construction of an internal
identity is a violation.
**Status.** DOCUMENTED — ADR 0001, Decision.
**Conformance at `9925ead8`.** Per ADR 0001; relied on by the agent
lifecycle standard in `15` (R8).
