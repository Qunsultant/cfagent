# Code standards — `docs/architecture/code/`

**Purpose.** This directory is the operational home for the code standards
every builder on this repository must follow. Each file states the standards
for one boundary, in normative form: a measurable definition, the status of
the standard, and its measured conformance. This set prescribes; it does not
survey.

**Canonical sources.** The canonical rule text lives in the sources each file
points to — gitops, the ADRs, the architecture and compliance documents, and
the pin headers. Each file below states the operational rule and points to its
canonical source; it does not copy the source wholesale. Where a source and
this set disagree, the source governs until this set is corrected.

## Why this set is a justified second home

`docs/agents/gitops.md` §22 states the single-home rule:

> **Single home for rules (owner direction 2026-10-29, #2299).** This
> document is the one place for all rules unless another place is justified.
> Issue bodies record proposals and point here; they are not parallel rule
> homes.

**Decision (2026-11-08).** gitops §22 will be amended to name this set as that
justified place for *code* rules: gitops keeps delivery and process rules;
this set is the operational home for the standards code must follow. Until
the amendment lands, this decision record is the set's authority — the set
claims §22's justification explicitly, and is not a parallel rule home by
drift.

## Assessments vs standards

This directory also holds four October-2026 documents — `overall-01.md`,
`component-taxonomy-01.md`, `screener-01.md`, `aop-fit-gap-analysis.md`.
Those are **assessments**: they describe and audit the code as found. This set
**prescribes**: it states what code must do. Where an assessment figure is
cited here, it is cited as dated history, never as a current measurement.

## Status legend

Every standard in this set carries one status:

- **ENFORCED** — a named pin, CI check, or script fails when the standard is
  broken. The check is named with the standard.
- **DOCUMENTED** — stated here (and in its canonical source) with no machine
  enforcement. Review enforces it.
- **ADOPTED-PENDING-IMPLEMENTATION** — decided by ruling (2026-11-08) but the
  machinery, consolidation, or restructure does not exist yet. The doc states
  the decided end state and says plainly that implementation is pending; it
  does not pretend the standard is in force.

A standard's conformance line gives the measured figure at the measurement
base (`origin/main` = `9925ead8`, 2026-11-08) and the method. Where violations
are baselined, the line reads "baseline: N at `9925ead8`, shrink-only, cleared
on touch" — the pins carry the baseline tables; these documents do not embed
them.

## The enforcement ladder

Standards hold because of the strongest layer that carries them, in order:

1. **Structural** — the violation is unrepresentable: types, ports, single
   definition sites. (Example: domain code cannot import a store client,
   `01` A1.)
2. **Machine pins in CI** — a census test with a named, shrink-only baseline;
   new code conforms immediately; every pin is mutation-checked. The merge
   queue makes a red check unmergeable. Policy Gate checks and lint ratchets
   sit on this rung. (`07` carries the pin inventory.)
3. **Process attestation** — the issue template's conformance checklist, the
   PR body's required lines, the verified completion report. Weaker than a
   pin; it exists for standards a machine cannot measure.
4. **Fleet convention** — stated practice relied on by review. Never the sole
   layer for a standard that matters; where a standard sits only here today,
   its file says so.

## Governing clause — touch conformance

**No grandfathering.** Every standard in this set applies in full to any
scope a change touches. Census baselines govern *untouched* code only.

- The **unit of touch** is the whole touched file, plus any pin surface the
  change moves (a route added in one file that changes an inventory pinned in
  a test touches that test's surface too). Directory-level touch is not the
  unit.
- When a PR touches a file, that file's baseline entries in every census are
  **void** for that PR: the file must pass the standard outright. Untouched
  files keep their baselines.
- The PR body carries a **`Touch conformance:`** line naming the standards
  whose touched scope was brought into conformance, or stating that no
  baselined file was touched.
- Where a touched file's behaviour is under-pinned, **characterization pins
  land before the conformance edit**, in the same PR.
- **Size standards** conform on touch by *budget assignment* (the file gains
  a shrink-only budget on the `13` P2 pattern), not by splitting the file
  inside an unrelated change.
- **Exception path:** where conformance on touch is impractical, the PR names
  the exception and a follow-up issue is filed in the same PR. An unnamed
  skip is a violation; a named exception is a decision.

`07-testing-and-pins.md` carries the mechanization (diff-scoped census
evaluation consuming the changed-file list the Policy Gate already computes).

## The domain-breakdown principle

Every registry, catalog, and port family has **exactly one home**. Inside the
home, the family is organized into **domain subdirectories with per-domain
files**, composed by **one index or registry**. Never a second home; never
one god file. This principle is applied concretely in `02` (ports and
adapters), `03` and `14` (the single outcome/error catalog), `10` (MCP
command classes), and `13` (directory structure).

## File index

| File | Standards for |
|---|---|
| `01-architecture-boundaries.md` | Port-first architecture, storage topology, the #290 trading barrel, thin routers, single-source schema, reuse |
| `02-data-access.md` | ADR 0022 operationalized: no naked SQL, dialect, transactions at the port boundary, migrations |
| `03-errors-logging-config.md` | The single catalog (domain layout), business messages, structured logging, externalized configuration, feature flags, observability port |
| `04-resolvers-and-context.md` | The resolver standard (one resolver per question) and context/identity resolution |
| `05-security-and-tenancy.md` | Server-side authorization and the PDP seam, tenant isolation, agent authority, secrets, MCP scopes, HITL and step caps |
| `06-client-ux-code.md` | UI primitives and design tokens, PageShell, density, accessibility — the code-facing UX subset |
| `07-testing-and-pins.md` | TDD, the five pin rules, the pre-merge battery, the pin inventory, touch-conformance mechanization |
| `08-deprecation-changelog-docs.md` | Retire-by-rename and the ledger, successor phrases, changelog, zero-touch docs merges, §23 records, ADR immutability, secret-shaped fixtures |
| `09-api-standards.md` | Dispatch order, envelopes, path conventions, versioning, API idempotency, pagination, OpenAPI discipline |
| `10-mcp-standards.md` | Adding a tool end to end, tool naming, sync-vs-queued, transports, catalog honesty (ADR 0012 scopes live in `05`) |
| `11-coding-and-naming.md` | Type discipline, the `any` ratchet, suppression ban, async idiom, adopted lint/format tooling, the naming standard |
| `12-design-principles.md` | SOLID / GRASP / GoF / 15-factor as the design bar; the per-slice review artefact; the sampled-audit proxy |
| `13-structure-and-file-organization.md` | Canonical homes, the ports-home ruling, placement of new files, one-class-per-file, file-size budgets |
| `14-cross-cutting-aspects.md` | The AOP wrapper idiom, catalog-emitted outcomes, registered-runner composition, never-throw sinks, the transaction and audit aspects |
| `15-agentic-saas-platform.md` | The platform families: idempotency, concurrency, versioning, auditability, provenance and honesty, cost governance, model standards, agent lifecycle, reliability and retention, privacy, time and i18n readiness |

## Rulings record (decided 2026-11-08)

| Ruling | Where it lives |
|---|---|
| gitops §22 to be amended to name this set as the justified operational home for code rules (amendment tracked separately) | This README |
| Success envelope: payload unwrapped; collections `{ items, nextCursor }`; errors `{ error, code }` from the catalog | `09` |
| One-class-per-file is absolute — no registry or adapter-family exemption | `13` (applied to MCP in `10`) |
| `src/data/` is the only ports home; `src/ports/` is dispositioned into it and ceases to exist; domain subdirectories inside `src/data/` | `13`, `02` |
| One catalog for outcomes and errors, laid out by domain subdirectories behind one registry — never one god file | `03`, `14` |
| Retention is one externalized, configurable, tiered policy (hot → archive → delete); audit/evidence default 365 days | `15`, `03` |
| Time: UTC stored, ISO 8601 on the wire, zone is data. i18n: readiness, not rollout | `15`, `09` |
| ESLint flat config + typescript-eslint type-checked rules + Prettier adopted as the tooling standard; `any` banned in new/touched code under a shrink-only baseline | `11` |
| The six agentic-SaaS completions (idempotency, optimistic concurrency, backup/DR, license discipline, performance budgets, eval requirement) are adopted as standards | `15` |
| Touch conformance: no grandfathering; baselines govern untouched code only | This README; mechanization in `07` |
| Domain breakdown: one home per family, domain subdirectories, per-domain files, one index | This README; applied in `02`, `03`, `10`, `13`, `14` |

## Known conflicts and their fix routes

These conflicts exist in the source documents today. Each has a tracked
follow-up as its fix route; none is silently omitted, and none is presented
as resolved.

| Conflict | Fix route |
|---|---|
| ADR index is stale and ADR 0004 exists twice (`0004-screener-workflows.md` and `0004-ux-token-architecture-no-exemptions.md`); the index omits 0021, 0022, 0023, 0026 | Tracked follow-up: ADR index refresh and 0004 disambiguation |
| Two anti-drift documents (`docs/compliance/anti-drift.md`, 142 lines; `docs/compliance/anti-drift-controls.md`, 87 lines) state the same thesis and gate table | Tracked follow-up: anti-drift consolidation (this set cites `anti-drift.md` as the framework and `multiple-implementations.md` as the catalog) |
| Repo AGENTS.md's deprecation summary lags gitops §22 (rename-to-`*.deprecated.*` + ledger is the current form) | Tracked follow-up: AGENTS.md deprecation-form update (`08` follows §22) |
| The AOP fit-gap analysis cites `src/errors/errorCatalog.json` as live; it is `errorCatalog.deprecated.json` and the live system is the single catalog | Recorded in `03` and `14`; the assessment itself is retained as history (assessments are not rewritten) |
| `api-mcp.md` records API violations as remediations, and its counts are stale (17 tools vs the live 118) | `09` is written from current code and the security docs; the assessment is cited as history only |
