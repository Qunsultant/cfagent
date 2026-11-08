# 03 — Errors, logging, configuration

**Purpose.** How failures and successes are coded and worded, how the system
logs, and where configuration comes from. One catalog, business language at
the surface, technical detail in the logs, no literals where a knob belongs.

**Canonical sources.** Issue #2381 (the single outcome catalog), issue #3515
(the console ratchet), ADR 0006 (feature flags), ADR 0011 (observability
port), `docs/agents/tech-standards.md` §5, and programme #1969 (CEO lane —
owner of the externalization programme; its AOP form is in `14`).

## C1 — One catalog, laid out by domain

**Definition.** Every user-facing error and success code and message is
defined in exactly one catalog and rendered through exactly one resolver
module. Redefining, copying, or hand-writing a code or message anywhere else
is a violation.

**Decided layout (ruling, 2026-11-08).** The catalog is one logical catalog
in one home directory, organized into **domain subdirectories**: each
domain's codes live in that domain's file(s), and a single registry/index
composes them into the one catalog. It is explicitly **not** one god file.
The two current shapes are the anti-pattern being replaced and are baseline
rows, not homes: the single `src/outcomes/outcomeCatalog.json` file and the
684-line `src/aspects/errorCodes.ts` (the data-foundation family's codes).
Under the ruling, `errorCodes.ts`'s family folds into the same domain-laid-out
catalog as one domain among the others; two catalogs, each single only within
its family, do not satisfy this standard.

**Status.** The one-catalog rule for outcomes is ENFORCED today —
`tests/error_catalog_r4.test.ts` and `tests/outcome_catalog_2381.test.ts` pin
the catalog shape and the existence of every referenced code. The domain
layout and the consolidation of the second catalog are
ADOPTED-PENDING-IMPLEMENTATION.
**Conformance at `9925ead8`.** Outcome catalog: pins green at base. Second
catalog: baseline — `src/aspects/errorCodes.ts` (684 lines) stands as the one
remaining separate catalog, shrink-only, cleared by the consolidation slice
or on touch.

## C2 — Business errors at the surface, technical detail in logs

**Definition.** A user-facing message states the business error (what the
user can understand and act on). Technical detail — stack traces, SQL, store
internals — goes to logs only, never into a user-facing message.
**Status.** DOCUMENTED — gitops §5 standing guardrails;
`src/outcomes/outcomeAspects.ts` header.
**Conformance at `9925ead8`.** Not pinned. Related measurement: raw
`throw new Error(` lines in `src/` number **1,443** at base (raw grep;
includes legitimate internal throws). No standard has ever counted or
baselined raw throws outside catalog paths; if one is wanted it takes the C4
treatment — a measured baseline and a shrink-only ratchet, not a prose ban.
Until then this standard governs messages at outcome boundaries (C1), not
every internal throw.

## C3 — The resolver never invents a code

**Definition.** The outcome resolver renders codes from the catalog only. An
unknown code passes through unresolved; the resolver never fabricates a
message for it, and a read through the resolver never fails — the resolver
never throws.
**Status.** ENFORCED — `tests/error_catalog_r4.test.ts` pins the
`codedMessage` rendering contract.
**Conformance at `9925ead8`.** Pin green at base.

## C4 — Structured logging; no new unstructured `console.*`

**Definition.** Logging is structured, via the structured logger
(`src/observability/structuredLogger.ts`). No new unstructured `console.*`
call may be added in `src/`. Remaining sites are per-file ceilings that only
shrink; a file whose count reaches zero is locked at zero permanently.
**Status.** ENFORCED — `tests/console_migration_ratchet_3515.test.ts`
(shrink-only). The logger is imported by 146 files at base.
**Conformance at `9925ead8`.** Baseline: 234 counted sites at the ratchet's
batch-3 baseline, shrink-only, cleared on touch. (A raw grep at base finds
241 `console.*` call lines; the pin strips comments and strings before
counting — the two figures are consistent, and the pin's count is the
operative one.)

## C5 — Secrets and sensitive content are redacted from logs

**Definition.** No secret, credential, or sensitive payload appears in a log
line. Log payloads pass through the sanitizing logging aspect
(`sanitizeForLog` in `src/aspects/loggingAspect.ts`); sanitization happens
inside the aspect, not by caller discipline (see `14` Q5).
**Status.** DOCUMENTED — `docs/agents/tech-standards.md` §5.
**Conformance at `9925ead8`.** Not mechanically measured.

## C6 — Log and telemetry shape

**Definition.** Log and telemetry events are structured, carrying trace,
tenant, and actor context, with W3C `traceparent` propagation. This standard
states the *practised* rule (C4's per-module structured logger) as the
operational form; ADR 0011 governs the port architecture behind it (C9). The
sources have historically stated this three incompatible ways
(`standards.md` §2.2, ADR 0011, the #3515 practice); this file does not invent
a fourth shape.
**Status.** DOCUMENTED — `docs/architecture/standards/standards.md` §2.2;
ADR 0011.
**Conformance at `9925ead8`.** Not mechanically measured beyond C4.

## C7 — Configuration is externalized

**Definition.** Flags and knobs come from configuration, not literals
embedded in domain files. Environment access goes through the config layer;
domain code does not read `env` directly. Retention values are configuration
under this rule (see `15`, reliability and retention).
**Status.** ADOPTED-PENDING-IMPLEMENTATION. At base this was a gap: no repo
standard and no enforcement existed — only the 2026-10-25 cross-cutting
directive and an AOP fit-gap finding. This file is its first standard home.
**Conformance at `9925ead8`.** No maintained measurement exists. The AOP
analysis counted 371 direct `env` accesses under its method; a rough grep at
base finds 171 lines matching `.env.` patterns in `src/**/*.ts` under a
narrower pattern — the two numbers are not comparable, and that
incomparability is the finding: nothing maintains the measurement. The
standard's first implementation step is a census on the C4 ratchet pattern:
measured baseline, shrink-only, cleared on touch.

## C8 — Feature flags sit behind `FeatureFlagPort` and fail closed

**Definition.** Feature flags are evaluated through `FeatureFlagPort`. The
port interface contains zero Cloudflare types, zero binding imports, and zero
environment variables. Every flag fallback fails closed.
**Status.** DOCUMENTED — ADR 0006, Decision items 1–2. This standard governs
how flags are built; no rule yet governs which capabilities must be
flag-gated (the AOP analysis's coverage finding — flags evaluated in only 16
locations — has no owner and no follow-up home; it is recorded here so the
gap is visible, not resolved).
**Conformance at `9925ead8`.** Flag construction: per ADR 0006. Flag
coverage: unmeasured.

## C9 — Observability sits behind one port

**Definition.** Observability is accessed through one port: one event schema,
key-based redaction, a never-throw sink. Domain code never imports a provider
SDK. The interceptor form of this standard is in `14` Q7.
**Status.** DOCUMENTED — ADR 0011.
**Conformance at `9925ead8`.** The port and interceptor exist (`14` Q7
measures their call sites); no rule requires new surfaces to wrap.
