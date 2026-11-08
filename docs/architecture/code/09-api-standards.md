# 09 — API standards

**Purpose.** The internal HTTP API: dispatch order, response envelopes, path
conventions, and the disciplines for versioning, idempotency, pagination,
and the generated OpenAPI document.

**Canonical sources.** `docs/architecture/security/api-security.md` (current,
operational), `docs/api-openapi-spike.md` (#1024), ADR 0012's neighbouring
surface in `10`. `docs/architecture/application/api-mcp.md` is an
October-2026 *assessment*: its standards content is a findings-and-roadmap
list, and its counts are stale. It is cited here as history only — this file
is written from current code and the security docs, not from the assessment.

**Measured surface at `9925ead8`.** ~123 distinct `/api/...` path literals in
route/server code; 1,842 `Response.json` calls across `src/agents` +
`src/server`; explicit status usage skews 400 (347) / 500 (305) / 503 (146) /
401 (118) / 403 (111) / 404 (103) / 409 (47) / 405 (38).

## J1 — Dispatch order is a security property

**Definition.** Worker dispatch order is fixed: static assets → public
routes (A2A cards) → session-gated routes → the generic `/api/*` forwarder
last. The forwarder is itself session-gated, so an unmatched path is never
an unauthenticated path. A refactor must preserve the order exactly;
reordering is a security change, not a cleanup.
**Status.** ENFORCED — `tests/server_route_inventory_2902.test.ts` pins
every route branch in dispatch order with method/auth guards (`01` A5).
**Conformance at `9925ead8`.** Pin green at base.

## J2 — Errors must not leak

**Definition.** The entrypoint is wrapped in `withErrorBoundary`. An escaped
throw becomes a real 5xx with a machine-readable code — never an edge error
page, never a stack trace. Corrupt-store paths return generic 500s.
**Status.** DOCUMENTED — `api-security.md` §4. The boundary is code and is
universally relied on, but no pin asserts the no-leak property per route.
**Conformance at `9925ead8`.** `withErrorBoundary` is referenced by exactly
2 files (its definition and the `src/server.ts` wiring); per-route leak
behaviour is unmeasured by any pin.

## J3 — Caller-supplied identity headers are stripped unless validated

**Definition.** Caller-supplied identity headers (`x-user-login`,
`x-user-id`) are stripped at the Worker entrypoint unless validated by
session or API key. An endpoint never acts on an unvalidated identity
header.
**Status.** DOCUMENTED — stated in the `api-mcp.md` assessment as a
remediation, which records it as not uniformly true at assessment time; no
standard or check has superseded that record. This file states it as the
standard going forward.
**Conformance at `9925ead8`.** Unmeasured by any pin; the assessment's
"not uniformly true" is the last recorded measurement and is not restated
here as current fact.

## J4 — Paths are plural, canonical, and alias-free

**Definition (decided form).** A canonical path is plural-noun, kebab-case,
with no verb segments and no aliases: one capability has one path. An alias
may exist only as a `*.deprecated` disposition with a removal issue.
Singular/plural mixes for the same resource family are violations.
**Status.** DOCUMENTED — the harvested rule (`api-mcp.md` §2) stated the
plural/canonical requirement without the measurable form; the definition
above is the decided form for this set.
**Conformance at `9925ead8`.** Baseline: the 123 distinct `/api/...`
literals at base, with live violations named by the assessment and still
present — the singular/plural mix (`/api/schedule/goals` vs
`/api/schedules`) and the alias families (`/api/foss/*` retained under
#1906, beside `/api/market-data/*` and `/api/market/*`). No route-shape lint
exists. A full per-path plurality audit is not mechanical (mass nouns, ids);
it is a sampled audit at census time. Shrink-only, cleared on touch.

## J5 — Response envelopes: one error shape, payload-unwrapped success

**Definition (ruling, 2026-11-08).**

- **Error:** `Response.json({ error: <string>, code: <catalogCode> }, { status })`
  — the error string is the business message (`03` C2) and `code` is from
  the single catalog (`03` C1). This is RFC 9457 problem-details semantics
  in the shape the codebase already speaks.
- **Success:** the resource payload itself, unwrapped. No `{ success: … }`
  and no `{ ok: … }` wrapper keys — the HTTP status already says success.
- **Collections:** `{ items: [...], nextCursor }`.

Any other envelope shape is a violation.
**Status.** ADOPTED-PENDING-IMPLEMENTATION. The error shape was dominant
practice with no document stating it; the success shape had no rule at all.
Both are now decided; conformance work is baselined below.
**Conformance at `9925ead8`.** Baseline: first-key census over
`Response.json({…` in `src/agents` + `src/server` — `{ error` 927 (the
conforming-dominant error shape), `{ success` 95 and `{ ok` 57
(≈86% dominant-shape share across first-key envelopes). The ~152
minority-shape sites are baseline rows, shrink-only, cleared on touch.
Payload-first success shapes were not counted by that grep and are counted
at census time.

## J6 — API errors at outcome boundaries carry catalog codes

**Definition.** An API error raised at an outcome boundary carries its code
from the single catalog (`03` C1/C2), not an ad-hoc string invented at the
route.
**Status.** DOCUMENTED at the API layer.
**Conformance at `9925ead8`.** Only 15 files under `src/agents` +
`src/server` import the outcome catalog at base; most route errors are the
J5 `{ error }` string shape without a catalog code. Baseline: those 15 files
are the conforming set; the remainder conforms on touch.

## J7 — API versioning: the recorded position

**Definition.** The internal API is unversioned: no `/api/v<N>` path prefix
and no version header. Compatibility is maintained by additive change and
by the deprecation discipline in `08`, not by parallel versions. Introducing
a versioned path family is a decision change: it requires an ADR and an
amendment to this file, not a local choice in a route PR.
**Status.** ADOPTED-PENDING-IMPLEMENTATION as a recorded decision. At base
there was no versioning standard, strategy, or recorded decision not to
version; this section is that record.
**Conformance at `9925ead8`.** Zero `/api/v<N>` paths and zero
version-header use in `src/` at base — the tree conforms to the recorded
position by fact; the decision is what was missing.

## J8 — Idempotency for mutating API calls

**Definition.** A mutating API call that a client may retry must accept and
honour a client-supplied idempotency key: a replay with the same key is
refused or returns the original outcome, fulfilling exactly once. This is
the API-layer form of the platform idempotency standard in `15` (R1).
**Status.** ADOPTED-PENDING-IMPLEMENTATION. No rule existed at the API layer
at base.
**Conformance at `9925ead8`.** Baseline: zero API-layer idempotency-key
adoption at base. One layer down the practice is pervasive — 624
`idempoten*` occurrences in `src/`, concentrated in `src/workflows/` — and
x402 replay is refused (`15` R1). API mutations conform on touch.

## J9 — Pagination: cursor, one envelope

**Definition.** List endpoints paginate by cursor. The response is the J5
collection envelope — `{ items: [...], nextCursor }` — with `nextCursor`
absent or null on the final page. Offset/page-number pagination and
per-endpoint envelope shapes are violations.
**Status.** ADOPTED-PENDING-IMPLEMENTATION. No pagination convention existed
at base.
**Conformance at `9925ead8`.** Baseline: only 18 route/server files
reference `limit` / `cursor` / `pageSize` parameters at base, each locally
shaped. They conform on touch; new list endpoints conform immediately.

## J10 — The OpenAPI document is generated from the endpoint catalog

**Definition.** The OpenAPI document is generated from the endpoint catalog
(`buildOpenApiSpec()` from `iaaaEndpointCatalog`) and served session-gated
at `/openapi.json` and `/api/docs`. Schemas are hand-written for pilot paths
only and are read from the handlers, never guessed.
**Status.** DOCUMENTED — `docs/api-openapi-spike.md` (#1024). The spike is
explicit that spec-vs-runtime drift is unchecked and the docs-exposure
decision is still open; both are recorded here as open, not resolved.
**Conformance at `9925ead8`.** Per the spike; no drift check exists.

## J11 — The endpoint directory is maintained, and is not the inventory

**Definition.** An endpoint directory is maintained (the `api-mcp.md`
categorization and the IAAA endpoint catalog). The directory is descriptive:
it under-reports the live surface today, and nothing reconciles it
mechanically. A directory entry is never evidence that a route exists or is
gated; the route inventories in `01` A5 / J1 are the evidence.
**Status.** DOCUMENTED.
**Conformance at `9925ead8`.** The directory exists; its under-reporting is
measured on the MCP side as 18 known absences (`10` K6).
