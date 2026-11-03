# Stock programme standards evidence pack (#2860, under #2764)

> **Rule for this document: a target is not a claim.** Nothing here claims
> compliance, certification, or attestation for the stock programme, and
> nothing here may be cited as such. Each row states what the repo says
> (a target, a baseline, or a requirement), what evidence exists for
> stock code, and the verdict. **This pack makes no new compliance claim.**
> A future slice that wants to claim compliance must produce the
> verification the row names as missing — not quote this pack.

## Verdicts

| Standard | What the repo says | Evidence for stock code | Verdict |
|---|---|---|---|
| OWASP ASVS | Required verification baseline; use an approved stable version, ASVS 5.0.0 (`docs/agents/tech-standards.md`) | No ASVS-mapped verification of stock code found: no ASVS references in stock tests or sources | **TARGET-ONLY** — baseline, not verified |
| WCAG 2.2 AA | Required product target for complete supported journeys (`docs/agents/tech-standards.md`, `docs/agents/ux-architecture.md` §20) | Component-scoped only: palette listbox semantics + modal focus trap (`tests/stock_search_palette_a11y_1695.test.ts`, `tests/ui_modal_focus_trap.test.tsx`); hub UX tests. Known gaps: `docs/architecture/UX/assessment-01.md` lists Non-Compliant items (target size 2.5.8, status messages 4.1.3). Patterns/presets tabs: NOT VERIFIED (audit #2860 §10) | **TARGET-ONLY** with named gaps — not compliant |
| SOC 2 | Conditional customer/business requirement; an assurance report, not a general software certification (`docs/agents/tech-standards.md`) | Control mechanisms exist repo-wide and are formalized (not attested) in `docs/architecture/security/soc2-controls-1774.md` — audit store, hash chain, PDP. No SOC 2 report or auditor opinion exists for the stock programme | **NO ATTESTATION** — not claimed |
| ISO (27001 / 9001 / other) | Nothing in repo standards names an ISO requirement for stock code | No ISO claim found in stock code or stock docs | **NO CLAIM** |
| 15-factor | `docs/architecture/application/screener.md` §9 carries a FULL COMPLIANCE table for the pre-existing screener capability | The table describes the pre-existing capability; it is not evidence for new stock-programme code (see the §9 scope note added with this pack). The per-factor re-audit for new stock code is now published at `docs/architecture/standards/stock-15-factor-reaudit.md`: 10 PASS / 5 PARTIAL / 0 FAIL / 0 NOT VERIFIED — NOT COMPLIANT as a whole | **QUALIFIED** — pre-existing description only; re-audit published, no compliance claim |

## What stock code DOES follow, with evidence

These are engineering practices the stock programme actually follows — not
external compliance claims. Each is pinned by a test or a doc the reader
can open:

| Practice | Evidence |
|---|---|
| SOLID / GRASP / GoF (`docs/architecture/ADD.md` #488) | Pattern registry, broker (`screenExecutionBroker`), planner, aspects — one join point per concern, no duplicated system |
| GitOps (`docs/agents/gitops.md`) | Merge queue only, `scripts/verify-before-merge.sh` green locally, policy gate, agent hashtag `#clo-arsi`, CHANGELOG fragment per PR |
| UX architecture §20 (`docs/agents/ux-architecture.md`) | Hub panels built only from `src/client/components/ui/` primitives, token-only styling (pinned by hub UX tests) |
| Anti-drift (`docs/compliance/anti-drift.md`) | Thin-router pin, global D-D census (shrink-only allow-list), orchestrator inventory pin |
| AOP join points | `pipelinePolicy` retry budgets, `breakerDecorator`, `outcomeCatalog` / `outcomeAspects`, `screenRunAspects` (logging + classification wired once at the funnel + chain submission) |
| Lossless inventory | Capability inventory (`src/workflows/stockScreenCapability.ts`) with canonical/target status per entry; no entry claims canonical without a production path |

## What would change a verdict

- ASVS: an ASVS-version-qualified requirement mapping with a verification
  run over stock code (not a chapter-number copy from an older edition).
- WCAG 2.2 AA: a journey-scoped audit of the stock journeys (including
  patterns/presets tabs) closing the assessment-01 gaps — component pins
  alone do not make a journey claim.
- SOC 2: an auditor opinion over a defined scope — control formalization
  alone never becomes attestation.
- ISO: a named ISO requirement adopted for stock code, with its own
  evidence — until then, nothing is claimed.
- 15-factor: the #2860 per-factor re-audit, now published at
  `docs/architecture/standards/stock-15-factor-reaudit.md` (10 PASS /
  5 PARTIAL / 0 FAIL / 0 NOT VERIFIED — NOT COMPLIANT as a whole),
  reported factor by factor from code evidence — never the
  hardcoded-COMPLIANT test, which asserts its own conclusion and must
  not be cited.
