# 07 — Testing and pins

**Purpose.** How changes are proven: TDD discipline, the five pin rules, the
pre-merge battery, the inventory of machine-enforced pins, and the
mechanization of touch conformance (the README's governing clause, made
operational).

**Canonical sources.** gitops §7 (TDD, the pin rules, agentic requirements),
§8 (before pushing), §10 (stop-the-line), repo AGENTS.md (pre-merge
checklist), ADR 0013 (test-parity harness), `.github/workflows/ci.yml`.

## G1 — TDD; reproduce before fixing; never weaken a test to get green

**Definition.** Behaviour changes follow TDD: define cases → observe failure
(Red) → implement (Green) → refactor → verify. A bug is reproduced before it
is fixed. A failing test is never deleted or weakened to obtain green; the
behaviour under test is never mocked away. Red/Green evidence is observed,
never claimed unobserved.
**Status.** DOCUMENTED — gitops §7. CI enforces the green end state, not the
Red step; the Red step is discharged in the PR's test evidence.
**Conformance at `9925ead8`.** Process standard; measured per PR, not per
tree.

## G2 — Pin rule 1: a change updates the pins it moves, in the same PR

**Definition.** A change that alters a pinned surface updates the
corresponding pin in the same PR. A pin updated later, in a cleanup PR,
means the surface changed unpinned — that gap is where drift accumulates.
**Carve-out (stated inline, by design):** pin rule 5 (`02` B4) excepts
migration *latest* — adding a migration updates the identity assertions it
touches, but the `latest` assertion belongs to `migration_registry.test.ts`
alone and is never bumped from a feature PR.
**Status.** DOCUMENTED — gitops §7, pin rule item 1. Self-revealing:
non-compliance surfaces as a failing pin.
**Conformance at `9925ead8`.** Process standard.

## G3 — Pin rule 2: no merge over a failing pin; a red pin on main stops the line

**Definition.** No PR merges while any pin fails. A pin red on `main` is a
stop-the-line event: it is classified (change-induced, baseline, flaky,
infrastructure, permissions), a corrective issue is filed or linked, and the
failure is escalated — never treated as background noise and never silently
skipped in a completion report.
**Status.** ENFORCED — required CI checks in the branch ruleset (gitops
§§10, 22).
**Conformance at `9925ead8`.** Gate in force at base.

## G4 — Pin rule 3: pins assert narrowly

**Definition.** A pin asserts the facts it exists to protect and no more. A
pin that false-fires is narrowed in the same PR that reveals the false fire
— not deleted, not widened into vacuity.
**Status.** DOCUMENTED — gitops §7, pin rule item 3.
**Conformance at `9925ead8`.** Process standard.

## G5 — Pin rule 4: a new shared surface ships with a pin, or says why not

**Definition.** A new shared surface — route family, token set, binding,
module boundary — ships with a pin in the same change, or the PR body
explicitly states why not. Silence is not a waiver.
**Status.** DOCUMENTED — gitops §7, pin rule item 4.
**Conformance at `9925ead8`.** Process standard. The `any` baseline (G10 in
`11`) and the C7 census in `03` are this rule's pending applications.

## G6 — The pre-merge battery runs on a fresh base

**Definition.** Before pushing: rebase onto current `origin/main`, then run
`scripts/verify-before-merge.sh` — it refuses a stale base and runs
typecheck, the migration latest-pin lint, the full test suite, and the
policy-gate regression check. Never push a red battery "to let CI sort it
out."
**Status.** DOCUMENTED — repo AGENTS.md pre-merge checklist; gitops §8. The
script machine-checks when run; running it is agent discipline.
**Conformance at `9925ead8`.** Process standard. The touch evaluation
(§"Touch conformance — mechanization" below) joins this battery so
void-on-touch failures surface before the PR, not in the merge queue.

## G7 — Required CI: strict typecheck, production build, full suite

**Definition.** Required CI is strict typecheck plus production build plus
the full Vitest suite (sharded). A red required check is diagnosed and fixed
— fast-gates (typecheck/build) failures and test-shard failures are separate
diagnoses — never merged over and never rebased around undiagnosed.
**Status.** ENFORCED — `.github/workflows/ci.yml` (Fast gates; Tests
shards); gitops §10.
**Conformance at `9925ead8`.** CI green at base.

## G8 — Migration and refactor work uses the test-parity harness

**Definition.** Migration/refactor work proves parity with the harness:
capture → compare → checklist → check → report (`npm run parity`).
**Status.** DOCUMENTED — ADR 0013.
**Conformance at `9925ead8`.** Process standard.

## G9 — Agentic changes carry the agentic test list

**Definition.** A change to agentic behaviour is tested for: tenant
isolation, tool permissions, approval binding, budget enforcement, retry
safety, interrupted execution, evidence provenance, model/provider failure,
prompt-injection resistance, and structured-output validation. A model's
agreement is never the sole correctness oracle for any of them.
**Status.** DOCUMENTED — gitops §7, "Agentic application requirements."
**Conformance at `9925ead8`.** Process standard; the eval requirement that
joins this list for model/prompt changes is in `15`.

## Pin inventory — the machine-enforced core

Fixed = the pinned fact may move only by a same-PR pin update (G2).
Shrink-only = the baseline may only decrease. Absolute = fixed at zero.

| Pin / gate | Enforces | Kind |
|---|---|---|
| `tests/global_dd_census_2356.test.ts` (+ step censuses 2345/2357/2358/2359) | `02` B1 — no naked SQL; per-table writer sets | Shrink-only |
| `tests/neutrality_census_3525.test.ts` | `08` H7 — platform-layer provider neutrality | Shrink-only (baseline 1,095 rows / 8,533 lines) |
| `tests/console_migration_ratchet_3515.test.ts` | `03` C4 — no new unstructured `console.*` | Shrink-only (234 remaining at batch-3 baseline) |
| `tests/ux_token_coverage_ratchet.test.ts` | `06` F2 — no raw color literals outside token sources | Absolute (zero) |
| `tests/ux_density_ratchet_1580.test.ts` | `06` F4 — density literals | Shrink-only |
| `tests/migration_registry.test.ts` + `scripts/check-migration-pins.sh` | `02` B4 — migration latest owned by one test | Fixed |
| `tests/trading-boundary.test.ts` | `01` A4 — barrel-only trading imports | Fixed |
| `tests/thin_router_inventory.test.ts` | `01` A5 — thin ordered dispatcher (24 delegations) | Fixed inventory |
| `tests/server_route_inventory_2902.test.ts` | `01` A5 / `09` J1 — every route branch, dispatch order, auth guards | Fixed inventory |
| `tests/schema_single_source.test.ts` | `01` A6 — one DDL source | Fixed |
| `tests/ui_primitives_inventory.test.ts` | `06` F1 — the `ui/` primitive export inventory | Fixed inventory |
| ADR 0012 completeness pin + `tests/tool_attribution_audit_1763.test.ts` | `05` E6 — every MCP tool scoped and named (120 factory + 4 scanner) | Fixed totals |
| `tests/error_catalog_r4.test.ts` + `tests/outcome_catalog_2381.test.ts` | `03` C1/C3 — catalog shape; every referenced code exists; resolver never invents | Fixed |
| `tests/dependency-pinning.test.ts` | `08` H8 — exact dependency specs; package.json = lockfile | Fixed |
| `scripts/ci/policy_gate.py` checks (a)–(j) | `08` H1–H5 + linked issue / lane label / hashtag | Fixed PR-level gate |
| Gitleaks (`.github/workflows/gitleaks.yml`) | `05` E5 — no secrets in the full PR commit range | Fixed |

## Touch conformance — mechanization

This section makes the README's governing clause operational. The pieces
already exist at base, measured:

1. **Pin rule 1 (G2)** is touch conformance for pinned surfaces, stated as
   policy.
2. **The Policy Gate is already diff-scoped**: `scripts/ci/policy_gate.py`
   computes `touched_files` from the PR diff (`git diff base...head`) and
   scopes its checks — docs scope, stale-base reversion, test deletion,
   deprecation checks (i)/(j) — to what the PR touches. It is a required
   check.
3. **The console ratchet's per-file lock** (C4) is the closest existing
   analogue: per-file ceilings, and a file at zero is locked at zero —
   improvement is permanent, regression in that file is impossible.
4. **Shrink-only censuses** (B1, H7) are tree-scoped today: touching a
   baselined file for an unrelated reason does not currently require
   clearing that file's rows. Touch conformance is the change that makes
   them touch-scoped.
5. **`scripts/verify-before-merge.sh`** is the local battery the touch
   evaluation joins.

**The mechanism (decided 2026-11-08; ADOPTED-PENDING-IMPLEMENTATION).**

- **Unit of touch:** the whole touched file, plus any pin surface the change
  moves.
- **Diff-scoped census evaluation:** each census pin gains a touch mode. For
  every file in the PR diff, that file's baseline entries are void — the
  file must pass the standard outright (zero counted violations of that
  family). Untouched files keep their baselines. The pins consume the same
  changed-file list the Policy Gate already computes; no new infrastructure
  category is needed.
- **Order of application:** (a) per-file mechanical families first — console
  (extend the existing lock to void-on-touch), neutrality rows, naked-SQL
  rows, `any` counts (once baselined, `11`), class-per-file and size budgets
  (once baselined, `13`); (b) shape families next (the resolver census under
  #3786); (c) non-mechanical families (design principles, `12`) discharge
  touch conformance through the PR body's conformance line and the per-slice
  review artefact, not through a test.
- **PR-body line:** the PR body carries a `Touch conformance:` line (README,
  governing clause). The Policy Gate checks the line's *presence* — the H5
  pattern: presence is checkable, quality is review.
- **Characterization first:** where a baselined file's behaviour is
  under-pinned, characterization pins land before the conformance edit in
  the same PR, and the PR body says so.
- **Local first:** the touch evaluation runs in the local battery (G6) so
  failures surface before the PR, not in the merge queue.

**Tensions, stated so builders plan for them.** Touch conformance clears a
file's *counted* rows for the families in force — it is not a licence to
expand a one-line fix into a decomposition project (size conforms by budget
assignment, `13`). Refactor-on-touch carries behaviour risk in exactly the
oldest, least-pinned files; the characterization-first rule and the named
exception path (README) are the mitigations. A lane avoiding baselined files
strands them; that is accepted — baselines shrink by slice work *and* by
touch, and touch is an accelerant, not the only engine.
