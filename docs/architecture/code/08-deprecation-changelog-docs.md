# 08 — Deprecation, changelog, docs, dependencies

**Purpose.** How things retire, how changes are recorded, how decisions are
preserved, and how dependencies are pinned. This file follows gitops §22
where §22 and repo AGENTS.md differ — AGENTS.md's deprecation summary lags
§22 (see the README's known-conflicts table; the AGENTS.md update is a
tracked follow-up).

**Canonical sources.** gitops §22 (no-deletion and deprecation rules, Policy
Gate contents, zero-touch documentation merges), gitops §23 (decisions
recorded in the repository), `docs/architecture/adr/README.md` (ADR rules),
issue #3525 (neutrality), issue #540 (dependency pinning).

## H1 — No PR deletes a file; retirement is rename + ledger

**Definition.** No PR deletes a file. To retire a file: rename it in place to
`*.deprecated.*`, add a header note naming the successor, and record the
entry in the single deprecation ledger
(`docs/architecture/transition/deprecations.md`). Deprecated files are
frozen: no new imports, and refactoring is permitted only to migrate
consumers off them. Sole exception: a deleted *test* file whose every test
name survives in an added file (#1917).
**Status.** ENFORCED — Policy Gate check (i) (`scripts/ci/policy_gate.py`);
the `deletion-watchdog` workflow stands behind it.
**Conformance at `9925ead8`.** Gate in force at base.

## H2 — A deprecation marker names its successor, in a recognized phrase

**Definition.** A deprecation marker in `src/` or `scripts/` — specifically
`@deprecated`, all-caps `DEPRECATED`, or comment-leading `Deprecated:` — must
name its successor in the same file's added lines, using a gate-recognized
phrase: `superseded by` / `superseded-by` / `replaced by` / `in favor of` /
`use … instead`. Casual prose mentioning the word is excluded.
**Status.** ENFORCED — Policy Gate check (j).
**Conformance at `9925ead8`.** Gate in force at base.

## H3 — Every PR carries a changelog entry

**Definition.** Every PR carries a changelog entry: under `## [Unreleased]`
in CHANGELOG.md, or as a `changelog.d/<issue>-<slug>.md` fragment.
**Status.** ENFORCED — Policy Gate check (d).
**Conformance at `9925ead8`.** Gate in force at base. Docs-only PRs under H4
are excepted.

## H4 — Docs-only merges are zero-touch, but never deletion

**Definition.** A docs-only PR — files strictly inside `docs/` plus root doc
markdown, excluding `changelog.d/`, `src/`, `tests/`, `scripts/`, `.github/`
— bypasses issue-linking, lane label, hashtag, process-checklist, and
changelog requirements. It never bypasses the no-deletion rule (H1) or the
docs-scope rule.
**Status.** ENFORCED — Policy Gate checks (d)/(e) scope logic.
**Conformance at `9925ead8`.** Gate in force at base.

## H5 — Process decisions are recorded in the repository

**Definition.** A hard-to-reverse or cross-cutting decision is recorded in
the repository — as an ADR where it is a decision of record — not left in
chat or agent memory. PR bodies carry the `Process documentation impact:`
line and point at the record instead of restating it.
**Status.** ENFORCED for presence — the Policy Gate fails a PR whose body
lacks the line. The gate explicitly does not judge quality; review does.
**Conformance at `9925ead8`.** Gate in force at base.

## H6 — ADRs are immutable; a changed decision gets a new ADR

**Definition.** ADRs are never deleted or rewritten. A changed decision gets
a new ADR that supersedes the old one; the old ADR's Status is updated with
a pointer to its successor. The deciding issue references the ADR and vice
versa.
**Status.** DOCUMENTED — `docs/architecture/adr/README.md`, "Rules."
**Conformance at `9925ead8`.** Process standard. The ADR *index* does not
currently meet its own discoverability bar (duplicate 0004; 0021/0022/0023/
0026 omitted) — a tracked follow-up, listed in the README's known-conflicts
table; this set links ADR files directly, never via the index.

## H7 — Provider/broker neutrality in the platform layer

**Definition.** Platform-layer code and copy do not present one provider as
the platform. Provider names live in the integration layer, behind the
ports.
**Status.** ENFORCED — `tests/neutrality_census_3525.test.ts`, shrink-only.
**Conformance at `9925ead8`.** Baseline: 1,095 file×term rows / 8,533
brand-term lines at base, shrink-only, cleared on touch. Platform rows were
dispositioned in the #3525 programme; the remainder is baselined as
integration, historical, or not-provider. The provenance half of this rule —
every served element carries which provider actually served it — is stated
as a platform standard in `15` (R5).

## H8 — Dependencies are pinned to exact versions

**Definition.** Dependency specifications are pinned to exact versions — no
floating `latest` tags — and `package.json` specifications equal the
lockfile's resolved versions.
**Status.** ENFORCED — `tests/dependency-pinning.test.ts`.
**Conformance at `9925ead8`.** Pin green at base. Update automation and the
license and vulnerability-response standards that complete this area are in
`15` (R12).

## H9 — Secret-shaped test fixtures are assembled from fragments

**Definition.** A test fixture that must contain a secret-*shaped* value (a
credential-validator rejection case, a hex token) is assembled from string
fragments at runtime, so no secret-shaped literal ever enters git history.
This matters because the scanner scans the full PR range (`05` E5): a
literal introduced in any branch commit fails the scan even if a later
commit removes it, and the fix is a rebuilt branch, not a fix-up commit.
**Status.** DOCUMENTED here for the first time — practised since PR #691 and
PR #1178, previously recorded only in agent-side memory. The Gitleaks gate
enforces the outcome (no secret-shaped strings in history); this rule states
the technique that keeps legitimate fixtures possible.
**Conformance at `9925ead8`.** Practice in force; no separate measurement —
the Gitleaks gate is the conformance signal.
