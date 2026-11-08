# 14 — Cross-cutting aspects (AOP)

**Purpose.** How cross-cutting behaviour is implemented: once, as an aspect,
composed — never hand-inlined per call site. This file standardizes the
wrapper idiom, composition, and the aspect inventory.

**Canonical sources.** Programme #1969 (CEO lane — **owner** of the
externalization programme this file documents; this file states the idiom
and points to #1969, it does not take the programme over), issue #817 (the
founding wrappers), `docs/architecture/code/aop-fit-gap-analysis.md` (an
assessment — its 16-aspect stack is the checklist below; its catalog claims
are stale, see `03` C1), ADR 0011 (observability port), ADR 0022 D-C
(transaction aspect), ADR 0008 (breakers).

**The inventory at `9925ead8`.** `src/aspects/` — `loggingAspect.ts` (277
lines: `AspectContext`, `withAspects`, `logAspectEvent`, `sanitizeForLog`,
`assertSandboxUrlSafety`), `errorCodes.ts` (684 lines — dispositioned under
Q2), `transactionAspect.ts` (394 lines, #2288), `nodeAsyncHooks.d.ts` (the
client-graph shim). `src/outcomes/outcomeAspects.ts` — where the #817
founding wrappers now live (`withLogging`, `withExceptionHandling`,
`withSecurity`, `BusinessError`, `codedMessage`); the original home,
`src/errors/errorAspects.deprecated.ts`, is retired per `08` H1/H2 with the
successor named. `src/observability/aspects.ts` (204 lines, #1743) —
`withObservability` + `withRequestObservability`. `src/breakers/breakerDecorator.ts`
— `withBreaker`. `src/security/iaaaAudit.ts` — the audit aspect's substance.
`src/data/transactionRunner.ts` + `transactionRunnerProvider.ts` — the tx
aspect's registration seam.

**Adoption, measured honestly.** The aspect *catalogs and types* are widely
imported — 50 files import a `src/aspects/*` module. The aspect *wrappers*
are barely wrapped around anything: `withLogging(` has **0** call sites
outside its definition, `withObservability(` 4, `withTransaction(` 3 direct
(the rest go through the registered runner, Q4). The idiom is sound and the
coverage is thin; both halves of that sentence are the conformance state,
and this file's standards are written against the second half, not just the
first.

**The fit-gap 16-aspect stack, re-verified at base.** Landed since the
analysis: **Transaction** (scored absent then; filled by the #1976 aspect,
Q3) and **Tracing/Correlation/Metrics** as one observability interceptor
(Q7; partial — propagation across queue/workflow boundaries was the stated
gap and remains open). Partial: Logging (ratcheted, `03` C4), Security
(wrapper exists, ~0 call sites), Validation (Zod at MCP inputs, no domain
wrapper), Caching, Rate Limiting (reactive 429 translation, no interceptor),
Memory Access, Tool Governance (the scope gate, `05` E6, is the substance —
not an aspect wrapper), Audit (manual `audit()` calls + hash chain, not
interceptor-driven), Human Approval (route checks, `05` E7). **Still absent
as aspects:** Multi-Tenancy context propagation, Guardrails
(prompt-injection/DLP as interceptors), Cost Tracking around LLM calls (Q8).

## Q1 — Cross-cutting behaviour is a `with*` wrapper over a context object

**Definition.** A cross-cutting behaviour is implemented as a higher-order
wrapper: a `with*` function taking a context object (`AspectContext`-shaped:
operationName, domain, optional audit/emit sink) plus the wrapped function.
Outcomes are emitted from the catalog, never as inline strings at call
sites. Hand-inlining a cross-cutting behaviour at a call site, where a
wrapper exists for it, is a violation.
**Status.** DOCUMENTED — the idiom is stated in the module headers
(`transactionAspect.ts`: "an AOP aspect in the established shape of this
directory… with every outcome emitted from the catalog per the #1969 rule").
**Conformance at `9925ead8`.** Shape: conforming where aspects exist.
Coverage: the wrapper call-site counts in the preamble (0 / 4 / 3) are the
baseline; new cross-cutting behaviour in a wrapped family uses the wrapper
immediately.

## Q2 — Every failure and success code is externalized, catalog-first

**Definition.** Every failure *and success* code and message is externalized
in the single catalog (`03` C1) and rendered catalog-first in every channel
— no per-channel hand-written variants. Success and outcome codes are
cataloged like failure codes. Aspect-emitted audit captures follow the same
rule.
**Status.** DOCUMENTED — programme #1969; recorded in the fit-gap analysis
Addendum (2026-10-27).

**Ruling applied (2026-11-08).** The survey documented a divergence: the
outcome half was executed in `src/outcomes/` (#2381) superseding
`src/aspects/errorCodes.ts` for outcomes, while `errorCodes.ts` remained the
catalog for the transaction/data-foundation family — two catalogs, each
single within its family. **That split does not satisfy this standard.** The
ruling is one catalog (`03` C1): the `errorCodes.ts` family folds into the
single domain-laid-out catalog as one domain among the others.
**Conformance at `9925ead8`.** Baseline: `src/aspects/errorCodes.ts` (684
lines) stands as the one remaining separate catalog, shrink-only, cleared by
the consolidation slice or on touch. The externalization rule itself
conforms where the outcome catalog's pins reach (`03` C1/C3).

## Q3 — Transactions are an aspect at the port boundary

**Definition.** One wrapped call is one atomic unit on exactly one backend.
A store that cannot honour the scope refuses **before any write** with the
typed `DATA_TX_CANNOT_HONOUR` refusal. Nested calls join the ambient unit;
only the outermost unit emits an outcome. (The data-access statement of this
rule is `02` B3.)
**Status.** ENFORCED — proof pins `tests/transaction_proof_2288.test.ts`,
and the per-port conformance suites exercise the wrapped semantics (the
suite registers the runner explicitly to pin them).
**Conformance at `9925ead8`.** Pins and suites green at base.

## Q4 — Aspect composition is a registered runner, resolved at call time

**Definition.** The server composition root registers the aspect-backed
runner once. Consumers import aspect **types only**. An unregistered context
resolves to no runner, and the consumer applies exactly its legacy
(sequential) behaviour — no partial aspect behaviour. This rule exists
because the transaction aspect's module graph reaches `node:async_hooks`,
which is server-only: a static or dynamic import of the aspect from a
client-reachable module breaks the client build (#2337, the #2303 lesson).
**Status.** DOCUMENTED — ratified here; at base it was stated only in module
headers (`src/data/transactionRunnerProvider.ts`) while being relied on by
every step-2+ data adapter.
**Conformance at `9925ead8`.** Practised by all step-2+ data adapters; the
types-only import discipline is the conformance surface, checked by the
client build (`07` G7) when violated.

## Q5 — The logging/observability aspect never changes behaviour

**Definition.** A failing sink never fails the call. The wrapper returns the
handler's result or response untouched — no injected headers, no altered
payload. Events carry codes and facts, never raw messages or secrets;
sanitization (`sanitizeForLog`) happens inside the aspect, so redaction
cannot be forgotten at a call site (`03` C5).
**Status.** DOCUMENTED — `src/observability/aspects.ts` header (#1743: "the
issue's parity criterion"); `src/aspects/loggingAspect.ts`.
**Conformance at `9925ead8`.** Per the interceptor implementation (Q7's call
sites); the parity criterion is the conformance test where suites exercise
the wrapper.

## Q6 — The audit aspect is append-only and hash-chained

**Definition.** Audit events are append-only, and each event links the
previous event's hash (`prevHash`, SHA-256 over the canonicalized event).
Audit emission is a coded outcome — code + message + structured payload —
retrievable through the read path: a captured record without its code,
message, and payload retrievable is a defect, not a record. Which actions
*block* when their audit write fails is a platform ruling, stated in `15`
(R4).
**Status.** DOCUMENTED — `src/security/iaaaAudit.ts`; #1969 Addendum
principle; #1968 (audit read path). The chain is code plus programme
rulings; this file is the first document to state it as the platform audit
standard.
**Conformance at `9925ead8`.** 30 files import `iaaaAudit.ts` at base; the
hash chain is live.

## Q7 — Tracing, correlation, and metrics are one interceptor

**Definition.** Tracing, correlation, and metrics are one Foundation-layer
interceptor over the observability port (`03` C9) — not three mechanisms.
New surfaces wrap with the interceptor (`withObservability` /
`withRequestObservability`) rather than wiring tracing, logging, and metrics
separately.
**Status.** DOCUMENTED — this file is the standard's first home; at base the
interceptor existed with no rule requiring new surfaces to wrap, and the
fit-gap analysis's stated gap — cross-boundary `traceparent` propagation
across queue/workflow boundaries — remains open and is recorded here as
open.
**Conformance at `9925ead8`.** Baseline: 4 `withObservability(` call sites
at base. New surfaces conform immediately; existing surfaces conform on
touch.

## Q8 — Every cross-cutting concern has a named aspect or port

**Definition.** Every concern in the cross-cutting list — exception handling,
logging, externalized codes/messages, configurability, security, transaction
management, cloud-agnostic and cloud-native construction — has a named
aspect or port as its *single* implementation. A concern implemented ad hoc
in more than one place, or in none, violates this standard.
**Status.** ADOPTED-PENDING-IMPLEMENTATION for the concerns still without an
aspect.
**Conformance at `9925ead8`.** Baseline (measured in the preamble): tenancy-
context propagation, guardrails, and LLM cost tracking have **no** aspect;
configurability has no aspect and, until this set, no standard (`03` C7 is
its home). The remaining concerns conform via Q1–Q7 and their ports.
