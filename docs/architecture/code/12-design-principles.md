# 12 — Design principles

**Purpose.** SOLID, GRASP, GoF, and the 15 factors as the platform's design
bar: what "well-designed" means here, and how conformance is discharged and
checked without pretending it can be grepped.

**Canonical sources.** `docs/architecture/standards/options-gof-grasp-solid-3186.md`,
`docs/architecture/standards/options-15-factor-3186.md`,
`docs/architecture/standards/stock-15-factor-reaudit.md` (the per-programme
reviews, in the #3186 format), `docs/agentic-org/architecture.md` §6 (the
15-factor numbering authority), the gitops §5 issue template.

**Measurement honesty.** Adherence to design principles is not mechanically
measurable, and this file does not fake a count. The cautionary evidence is
in the tree: `tests/fifteen_factor_and_usability.test.ts` asserts its own
conclusion — a hardcoded-COMPLIANT test that the 15-factor auditors
explicitly disowned as evidence. A self-asserting test is anti-evidence and
is never cited as conformance for anything in this file. Conformance here is
discharged by the review artefact (N6) and checked by the sampled audit
(N5); the mechanical correlates that do exist — port boundaries (`01` A1),
one-controller-per-run shape, registry-not-hardwired — are enforced
structurally under their own standards, not by principle name.

**Factor numbering.** "15-factor" in this repository follows
`docs/agentic-org/architecture.md` §6 ordering (factor 15 = auth) — not the
classic 12-factor-plus-3 ordering a reader may assume. Both #3186 reviews
warn about this; every future audit uses the §6 numbering or states its
deviation.

## N1 — New workflow/pipeline code is designed against GoF patterns, by name

**Definition.** New workflow and pipeline code names the GoF patterns it
uses. The platform's working set is: Template Method, Strategy, Observer,
Adapter, Registry, Facade. A design that cannot name its patterns has not
been designed against this standard.
**Status.** DOCUMENTED — `options-gof-grasp-solid-3186.md` maps each pattern
to its #3186 site. Binding today on the programmes that wrote reviews; this
file is the first platform-wide statement.
**Conformance at `9925ead8`.** Not mechanical — discharged per slice via N6.

## N2 — GRASP responsibilities govern module placement

**Definition.** Module placement follows GRASP: Information Expert, Low
Coupling, Controller, Creator, High Cohesion. A class is placed where the
information and responsibility already live; coupling introduced across a
boundary for convenience is a violation. (The #290 trading barrel, `01` A4,
is this standard's Low-Coupling enforcement in mechanical form.)
**Status.** DOCUMENTED — `options-gof-grasp-solid-3186.md`.
**Conformance at `9925ead8`.** Not mechanical — discharged per slice via N6.

## N3 — SOLID is the design bar, declared per issue

**Definition.** SOLID is the stated design bar for new code. Every issue
declares its SOLID/GoF/GRASP/15-factor alignment in its Engineering
standards and Conformance sections (the gitops §5 template requires both).
**Status.** DOCUMENTED — attested per issue, never audited platform-wide;
N5 is the audit mechanism that closes that gap.
**Conformance at `9925ead8`.** Attestation in force via the template; audit
pending under N5. (The ADD's "Standards conformance" section anchors
conformance to issue #488, closed 2026-11-02; this file is the standing
statement that anchor lacked.)

## N4 — 15-factor is audited per programme, with no partial compliance claims

**Definition.** Each programme is audited against the 15 factors (§6
numbering) with PASS / PARTIAL / FAIL verdicts and named remediation per
factor. While any factor is PARTIAL, the programme is **not compliant as a
whole**, and no document may claim otherwise.
**Status.** DOCUMENTED — `options-15-factor-3186.md`;
`stock-15-factor-reaudit.md` (#2860 format).
**Conformance at `9925ead8`.** The #3186 audit: 9 PASS / 6 PARTIAL —
recorded, in its own words, as "NOT COMPLIANT as a whole." That is the
conforming way to report a partial result, and the model for N5 sampling.

## N5 — The audit mechanism: review artefact + sampled audit

**Definition.** Principle adherence is verified by two mechanisms and no
others: (a) the per-slice design review (N6) as the standard artefact for
Large work; (b) a sampled audit — a rotating sample of files reviewed
against a short checklist on a stated cadence (the survey's proposal: 10
files per quarter). Self-asserting artefacts (a test or doc that declares
its own compliance) are not verification and are never accepted as such.
**Status.** ADOPTED-PENDING-IMPLEMENTATION — no checker or audit cadence
existed at base; this section creates the mechanism, and the cadence has not
yet run.
**Conformance at `9925ead8`.** Baseline: zero platform-wide audit coverage
at base; two programme audits exist (N4). Under touch conformance, the
N-area families discharge through the PR body's conformance line plus the
review artefact (`07`), not through a test.

## N6 — Per-slice design reviews are how N1–N4 are discharged

**Definition.** For Large work, the slice ships a design review in the
#3186 format — principle → where implemented → what remains — in the same
change. The review names partial results partial (N4's rule).
**Status.** DOCUMENTED — the three review documents are the precedent.
**Conformance at `9925ead8`.** Three reviews exist at base (options GoF/
GRASP/SOLID, options 15-factor, stock 15-factor reaudit).
