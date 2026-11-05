# RSI-CEO — Organization and Strategy Platform Plan

_Author: `#ceo-aimp` · 2026-11-05 · Domain: [`docs/agentic-org/platforms.md`](../agentic-org/platforms.md) §1 (CEO — Organization and strategy platform), §5 (governed RSI), §6B (frameworks as executable controls) · Mission contract: [`mission.md`](../agentic-org/mission.md) §4_

Status: **proposed** — candidate 1 is bounded and ready for an issue; candidates 2–3 are deferred until candidate 1's outcome is measured.

## 1. What this platform is

The CEO platform does not write product code. It owns the two things that make every other platform's improvement *countable*: **a portfolio that is true**, and **a decision record that explains why the next cycle was chosen** (mission §6: `cycle 1 result → explains cycle 2 selection`).

| platforms.md element | What exists in this repo today | Gap |
|---|---|---|
| Governance — who decides, approves, accepts risk | [`gitops.md`](../agents/gitops.md) §22 Policy Gate, §11 merge queue, §15 completion reports, `lane:*` ownership labels | Decision rights are stated **per rule**, never as one authority matrix an agent can consult |
| Domain practice | Balanced Scorecard / OKRs (platforms.md recommendation) | No objective register; no scorecard; objectives live only in issue prose |
| Architecture — capabilities, services, dependencies | Program issues with explicit dependency lines (e.g. #3216 → #3231 → #3232 → #3233 → #2853) | Dependencies are correct **inside one program** and invisible **across** programs |
| Operating model | issue → branch → PR → merge → post-merge verification (gitops §11) | No portfolio-level cadence: nothing states which program is next or why |
| Assurance | Policy Gate + required checks + independent review | Enforcement is strong; nothing independently audits **claims of progress** |
| Improvement | mission §4 contract, §6 three-record chain | The three records are not linked to anything durable |

Frameworks are adopted only where they become executable controls (§6B). Balanced Scorecard supplies the four perspectives below; COSO ERM supplies the "reserved decision" boundary; COBIT supplies the control that a claimed state must have evidence. No framework is adopted as vocabulary alone.

## 2. Evidence (observed 2026-11-05, reproducible)

**F1 — The portfolio is written as prose and decays within days.**
`docs/plans/` holds 10 plan documents; six were written in one batch on 2026-10-20. They are hand-maintained status tables, and they are already wrong:

- [`rsi-product-plan.md`](rsi-product-plan.md) line 3 says `Status: IN PROGRESS` for issue #688 — #688 is **CLOSED**.
- The same file's Tier 1 lists `#79 … PR #674 (pending CI)` — #79 is **CLOSED**.

Reproduce: `gh issue view 688 --json state` and `gh issue view 79 --json state` against the rows cited in that file. Meanwhile the repository carries **419 open issues** (`gh issue list --state open --limit 1000 --json number`). An agent choosing work today cannot use the plans to decide, and no reader can tell which rows are still true.

**F2 — Progress claims have no outcome field, so "Done" means "merged".**
gitops §15 closes an issue with an implementation report; nothing records the *effect* the change was supposed to have, or whether it was observed. mission §6 requires the opposite: a cycle's result must explain the next cycle's selection. Every issue that closes therefore ends the chain instead of feeding it.

**F3 — Decision rights are scattered across rules, not stated as a matrix.**
`AGENTS.md` reserves repository settings to the human owner; gitops reserves emergency exceptions; `lane:*` labels assign ownership. Three places, no single answer to "may this agent take this decision, or must it escalate?" — the exact question mission §4 `authority:` asks every mission to answer.

**What is *not* a finding.** The enforcement plane is healthy, and this was verified rather than assumed: PR #3254's Policy Gate rejected the branch in 7 seconds for a stale base and a missing §9 checklist line, naming both with file paths. The control works. What is missing is **state**, not **enforcement** — which is why this plan builds a register rather than a new gate.

## 3. Baseline (scorecard, before any change)

| Dimension | Measure | Baseline | How measured |
|---|---|---|---|
| Strategic progress | Portfolio rows that name objective, owner, dependency, evidence | **0** (no register exists) | register file presence |
| Portfolio truth | Plans whose stated status matches GitHub | **2 of 2 sampled rows wrong** (#688, #79) | `gh issue view` vs plan row |
| Unresolved dependencies | Cross-program dependencies with a named blocking issue | **not instrumented** | — |
| Governance exceptions | Policy Gate findings per new PR | **2 findings / 1 PR** (this slice, both mechanical) | Policy Gate log |
| Realized benefits | Closed issues with an observed outcome recorded | **0** (no field exists) | — |
| Flow | Open issues | **419** | `gh issue list` |

## 4. Candidate 1 — a register that cannot claim what it cannot prove

**Change.** One file, `docs/plans/portfolio-register.md`, plus a contract test that holds it to its own rules. One row per initiative:

```
objective | initiative | issue | owner (lane label + #hashtag) | depends on | state | evidence | next checkpoint
```

States are fixed: `proposed`, `in-progress`, `in-review`, `blocked`, `done`, `retired`. Rules the test enforces:

1. `done` and `in-review` require evidence naming a PR number; `done` additionally requires the post-merge verification reference (gitops §11).
2. `blocked` requires the blocking issue number; an unnamed blocker is not a blocker.
3. Every row's owner is an existing `lane:*` label (gitops §9), so ownership stays greppable.
4. No issue appears twice — one initiative, one row, so two lanes cannot both call it theirs.
5. The register carries a snapshot date; a register older than 14 days fails the test. Staleness becomes a red check instead of a silent drift.

**Hypothesis.** A register with those five rules reduces "documented status contradicts GitHub" from 2 of 2 sampled claims to 0 at two consecutive weekly reconciliations, at a cost below 10 minutes of agent time per merge — measured, not asserted.

**Acceptance.**
- `tests/portfolio_register_contract.test.ts` fails on each of the five rules independently (five negative cases, one positive).
- The register's first snapshot covers the three live programs (#3216 broker/provider agnosticism, #2902 server dispatch slices, #2853 panel contract) with their real states.
- The stale-snapshot rule is proven by a fixture, not by waiting 14 days.
- No deletion, no gate change: §22 is untouched, and the register is additive.

**Guardrails.** The register never becomes an authority over GitHub: it cites issues and PRs and is validated against them; it never restates a state the issue tracker contradicts without evidence. The test reads the register only — no network in CI — so it cannot fail for reasons outside the repository.

**Rollback.** Revert the register commit; nothing else consumes it. No migration, no runtime surface.

**Why this is the smallest sufficient change.** Candidates 2 and 3 (below) both need a register to attach to. Building them first would mean building an outcome ledger for initiatives nobody can enumerate.

## 5. Deferred candidates (not approved for this cycle)

**C2 — Outcome field in the §15 completion report.** Add `Outcome: observed | not-yet-observable | negative` to the report template and require `not-yet-observable` rows to come back with a checkpoint. Directly targets F2. Deferred because it is a governance-template change, which platforms.md §5 classifies as the third kind of change — human-governed approval path, not an agent's call.

**C3 — `docs/agents/authority-matrix.md`.** One table: decision → may agents take it → who must approve → evidence required. Targets F3. Deferred because it duplicates rules currently spread across `AGENTS.md` and gitops §22; consolidating them is a governance edit that a human owner should ratify, and doing it before candidate 1 measures anything risks a second unmaintained document — exactly F1.

## 6. Sequence and exit evidence

| Phase | Work | Exit evidence |
|---|---|---|
| P0 (this plan) | Register skeleton + first snapshot of three live programs | A reader can answer "what is next and why" in one file |
| P1 | Contract test, five negative cases | Red on each rule violation; green on the real register |
| P2 | Two weekly reconciliations | 0 contradictions vs GitHub at two consecutive snapshots |
| P3 | Decide C2 on measured cost | Register rows that stayed `in-progress` > 3 cycles with no evidence → the data C2 needs |

Mapping to platforms.md §7: this plan is phase 6 (cross-platform RSI) applied to the *coordination* plane — it makes the improvement portfolio auditable, without touching phases 1–5's research/trading controls.

## 7. Authority — what this platform does not decide

- Repository settings, branch protection, merge-queue policy: human owner (`AGENTS.md`).
- Governance and evaluation-system changes (C2's template, C3's matrix, any change to how success is judged): human approval, per platforms.md §5.
- Promotion of a candidate to `done`: independent review plus post-merge CI, never self-certified (mission §2, "The candidate builders must not control final passing criteria").
- Investment, live-trading, and risk limits: outside this platform entirely (platforms.md §4).

## 8. Next-cycle trigger

After P2, the next candidate is chosen by the register, not by preference: the row that has been `blocked` longest with a named blocker, or the row that has produced the most `in-progress` cycles without evidence. If neither exists, the correct result is **no new cycle** — a portfolio that is true and idle is a better outcome than one that is busy and unverifiable.
