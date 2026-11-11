# Platform optimization plan: the improvement and RSI plane

- **Date** 2026-11-11 · **Status** proposed · **Owner** platform strategist, improvement and RSI domain
- **Scope** The improvement plane of the federated model — candidate generation, sandboxing, independent tests, promotion (`docs/agentic-org/platforms.md:96`) — as it is actually operated through this repository's delivery machinery, together with the evidence plane it depends on (`docs/agentic-org/platforms.md:95`) and the control plane that bounds it (`docs/agentic-org/platforms.md:94`).
- **Authority** None of its own. `docs/agents/gitops.md` is the single home for delivery rules (`docs/agents/gitops.md:1636`); this is a plan, and where it and gitops disagree, gitops wins.
- **Read for this document** `docs/agentic-org/platforms.md` §3, §5, §6E, §7; `docs/agentic-org/agentic-roles.md` §7; `docs/agents/gitops.md` §7 and §22; the `scripts` block of `package.json`; `docs/architecture/agentic/mcp-server-inventory.md` §2.2. Nothing else — no repository survey. A claim that would need a file outside that list is marked unverified instead of asserted.

Two counts here were obtained by running, not by reading: `docs/agents/gitops.md` contains exactly 24 top-level `## N.` sections, and `package.json:18` names 9 pin suites (checked with a one-off `node -e` script over both files; output `sections 24`, `pins 9`). No test, lint or build was run for this plan — the brief named no check to run, and §5's exit evidence below is a proposal, not a result.

**Position in one paragraph.** This repository has a strong *control plane* and a strong *procedural* improvement loop: test-first, pinned surfaces, review, queue merge, daily audit. It has no *evidence plane for improvement* — nothing in the record is a measurement a second party can recompute. The proof is structural rather than rhetorical: the change record is prose in an issue (`docs/agents/gitops.md:651`), and the machine-readable assertions it does have freeze the shape and count of surfaces rather than their effect (`package.json:18`). Every section below follows from that asymmetry: the platform can already describe itself, and cannot yet score itself.

## 1. Where the platform stands today

### 1.1 What "this platform" is

The improvement plane is not a deployment. In the federated model it is the discipline by which any domain platform proposes, evaluates and promotes a change, sharing one control plane and one evidence plane rather than owning a private stack (`docs/agentic-org/platforms.md:102-114`). Its protected set is therefore the *union* of the protected columns of §5's table for every domain it touches — protected evaluations and privilege boundaries for agents, security and reliability gates for technology, approvals and budgets for operations (`docs/agentic-org/platforms.md:196-208`). That union is what §3 below calls the never-list.

### 1.2 The seven mechanisms that exist

| Mechanism | Where it lives | What it actually freezes | What it cannot tell you |
|---|---|---|---|
| 24-section delivery policy, one issue one PR | `docs/agents/gitops.md:650`; 24 sections verified by count | Traceability: every change has one issue, one PR, one §15 report (`docs/agents/gitops.md:645-651`) | Whether the change was worth making; the report's value claim is author prose |
| Nine pin suites | `package.json:18` | Frozen shared surfaces: tool attribution, mesh registry (2), OASF records, thin router inventory, neutrality census (#3525), global dd census (#2356), trading extraction ledger, policy gate guards | Any outcome. A census pin fails when a count moves, not when the change is bad |
| Census pins specifically | `tests/neutrality_census_3525.test.ts`, `tests/global_dd_census_2356.test.ts` as named in `package.json:18` | A population count at a point in time | Direction of travel: a census that rises and a census that falls both pass or both fail identically |
| Lint ratchet | `docs/agents/gitops.md:600-618`; `scripts/lint-changed.mjs` via `package.json:25-26` | Defect-class rules only, changed files only (`docs/agents/gitops.md:606-615`); recorded backlog 31 findings across 23 files (`:616`) | Code quality in general: style and formatting are explicitly out of scope, and untouched files are never audited |
| Lane labels | `docs/agents/gitops.md:1522-1550` | Filterable ownership: `lane:<agent-id>`, seven labels live, finance has none (`:1526-1532`) | Historical denominators. Backfill reached 311 of 1,358 items; 1,047 stay unlabeled by rule (`:1549-1550`), so lane is unusable as a retroactive denominator |
| Completion report as single record | `docs/agents/gitops.md:651`; §15 at `:1161` | One place per change for what was built, what proves it, and what value it created | Comparability. It is a document per issue, not a schema; no two reports share fields |
| Policy Gate and ruleset | `docs/agents/gitops.md:1583-1588`; ruleset `protectmain` id 25543527, verified 2026-11-09 (`:1567-1570`) | Presence of linked issue, lane label, agent hashtag, CHANGELOG entry, §23 line; five required checks (`:1563-1567`) | Whether any challenge occurred. Every gate field is an attribution field, not an evaluation field |

The control plane is the one part of the platform with countable, current numbers: 6 scopes over 134 tools, every tool declaring exactly one scope and executing through `executeWithPermissionGate` — 65 `mcp:read`, 27 `mcp:write`, 7 `mcp:execute`, 21 `mcp:trade`, 10 `mcp:payments`, 4 `mcp:admin` (`docs/architecture/agentic/mcp-server-inventory.md:73-87`). That is a real baseline for the permission never-list, and §4 uses it as one.

### 1.3 The absence that defines the work

The `scripts` block (`package.json:8-28`) contains `test`, `test:ci`, `test:pins`, `test:quarantine`, `test:workers`, `test:watch`, `typecheck`, `check`, `parity`, `lint:changed`, `lint:audit`, `test:coverage`, `dev`, `build`. Not one command records a candidate, an evaluation, a decision or a promotion. Coverage exists but is a partial report by construction, with no threshold, because a threshold needs a recorded baseline first (`docs/agents/gitops.md:620-626`). So: the platform's improvement loop is *procedural* — TDD (`:542-598`), pins (`:673-701`), review — and not *instrumented*. The nine pins freeze surfaces; none of them evaluates a change against a predicted effect. No file I read establishes a protected test set held by someone other than the candidate's author; I did not survey `tests/` beyond the nine names in `package.json:18`, so that is a finding about what the named evidence shows, not a claim that no such set exists.

## 2. The governed loop applied here

`platforms.md` §5 prescribes one common improvement protocol with domain-specific evidence (`docs/agentic-org/platforms.md:182`). The protocol is adoptable now; the evidence stays this domain's — tests, pins, lint, audit — rather than trading metrics. Role separation is `agentic-roles.md` §7: the improvement agent proposes, engineering builds, an independent quality agent evaluates against protected criteria, security and risk assesses exposure, an authorized release owner approves, operations rolls out and can roll back (`docs/agentic-org/agentic-roles.md:247-263`), and the proposer must never control both the candidate and its acceptance criteria (`:266`).

| # | Step (§5) | Artifact that exists today | Owner per `agentic-roles.md` §7 | Gap this plan must close |
|---|---|---|---|---|
| 1 | Observation | Issue `## Problem` field (`docs/agents/gitops.md:159`); `[audit]` issues filed by Main Audit (`:1678-1687`); a failing pin | The lane agent whose surface is observed (`docs/agents/gitops.md:1522`) | No observation taxonomy: the lint ratchet holds a defect-class list (`:606-615`), nothing holds a class list for workflow or evaluation defects |
| 2 | Diagnosis | The same issue's Problem plus `## Scope` (`:159`, `:175`) | Lane agent, with the improvement owner | Diagnosis is not separated from the proposed fix, so a wrong diagnosis is indistinguishable from a wrong implementation |
| 3 | Hypothesis | `## Outcome` and `## Acceptance criteria` (`:162`, `:179`) | Proposing agent | The template has no field for predicted effect or falsifier — its fields are Agent, Problem, Outcome, User journey, Scope, Acceptance criteria, Test plan, Dependencies, Change management, Conformance, Agentic design, Engineering standards, Standing guardrails, Completion report (`:156-254`). A hypothesis without a predicted effect cannot be refuted |
| 4 | Bounded candidate | One branch, one PR per issue (`:650`); `## Agentic design` names policies and budgets (`:667`) | Engineering / the relevant function | Bound is social (sizing guidance `:301`, small slices `:384`) rather than declared; nothing records what the candidate is forbidden to touch |
| 5 | Isolated evaluation | Red/green record (`:564-578`), `npm run test:pins`, `npm run lint:changed`, CI Fast gates | Author — which is the defect | The evaluator is the author. Isolation exists for *code* (tests fail before the fix) and not for *claims* |
| 6 | Independent challenge | PR review; Policy Gate (`:1583-1588`) | Independent Quality Agent (`agentic-roles.md:253-254`) | The gate checks that fields are present, never that anyone challenged the claim. No challenge record exists to be inspected |
| 7 | Authorized promotion | Queue merge under ruleset 25543527, empty bypass list expected (`:1561-1575`); workflow-file PRs need a human merge click (`:1665-1670`) | Authorized release owner | For non-workflow files, promotion is automated once checks are green — including changes to the pins and the lint config themselves (§3) |
| 8 | Monitored adoption | §17 post-merge verification (`:1222`); daily Main Audit (`:1678`) | Operations | Monitoring checks provenance and breakage, not the candidate's predicted effect. Nothing reads the hypothesis at step 3 again |
| 9 | Retain, revise, reverse, retire | Deprecation ledger for files (`:1591-1600`, `docs/architecture/transition/deprecations.md`) | Release owner with the improvement owner | No withdrawal record for a *decision*. A merged improvement can only be undone by another issue, which loses the reason the first one was believed |

Steps 3, 5, 6 and 9 are where the loop is thinner than its own machinery. Steps 1, 2, 4, 7 and 8 have real artifacts a reviewer can open today.

Two structural observations about the loop as it runs here. First, its cadence is per-change and ends at merge: steps 1 to 8 are bounded by one PR, and step 9 has no trigger, no owner on a schedule, and no artifact — so the loop is open at the bottom. A protocol that never formally ends a candidate cannot accumulate a record of what it withdrew, and therefore cannot distinguish a platform that is improving from one that is merely accumulating. Second, §5 applies per candidate, not per platform (`docs/agentic-org/platforms.md:182`). A platform-level scorecard is an aggregation over candidates; it cannot be declared, only assembled. That is why §4 below reads as an agenda of missing numbers rather than a dashboard, and why §5's first phase is a sampling exercise rather than a build.

A third observation is about who writes the record. In steps 1 to 5 the author of the candidate is also the author of its evidence, and `agentic-roles.md` §7's independent role exists only from step 6 onward (`docs/agentic-org/agentic-roles.md:253-254`). The separation is correct by design — engineering must build what it proposes — but it means the evidence *format* has to carry the independence, because the process does not. A record that a second party cannot recompute without asking the author collapses steps 5 and 6 into one, whatever the org chart says.

## 3. Three kinds of change, and the never-list

`platforms.md` §5 distinguishes execution adaptation inside an approved workflow, reusable capability improvement, and governance or evaluation-system change; the third needs a separate human-governed approval path, because an agent must not improve its reported performance by changing how success is judged (`docs/agentic-org/platforms.md:210-216`).

| Kind | Examples in this repository | Path | Mechanical difference today |
|---|---|---|---|
| 1 — Execution adaptation | A bug fix inside an existing route; a test added for an untested branch; a doc correction | Lane agent: issue → PR → merge queue (`docs/agents/gitops.md:650`, `:1561-1575`) | None beyond the standard gates |
| 2 — Reusable capability improvement | A new shared surface with its pin (`:680`); a consolidation that folds a duplicate into the canonical implementation (`:632-641`) | Same path, plus a pin in the same PR (`:675-677`) and an explicit reuse justification in the completion report (`:638-641`) | Automatically mergeable when green, except for workflow files (`:1665-1670`) |
| 3 — Governance or evaluation-system change | Editing `eslint.config.mjs`'s rule set; adding or removing a suite in `package.json:18`; changing a census pin's expected count; editing the §15 report template; editing lane labels; changing the measures in §4 of this plan | Separate, human-governed approval (`docs/agentic-org/platforms.md:216`) | **Incomplete.** The only withhold I can evidence is for workflow files, which get no auto-merge and need a human click (`docs/agents/gitops.md:1665-1670`). Nothing I read withholds a merge for `eslint.config.mjs`, `package.json:18` or the census tests, so today kind 3 is a convention for most of its surface, not a gate |

### 3.1 Classifying a real change

Four changes that look alike and are not:

| Change | Kind | Why |
|---|---|---|
| A flaky selector fixed in an existing test | 1 | Behavior of the test changes; no criterion moves |
| A pin added for a newly introduced route family | 2 | New shared surface takes its freeze in the same PR (`docs/agents/gitops.md:680`) |
| `eslint.config.mjs` gains a rule class | 3 | The rule set is the acceptance criteria for code; widening it changes what every future PR is judged against |
| A census pin's expected count is raised | 3 | The number is a judgement about the population, not a fact about it — and the pin exists precisely so that judgement is made deliberately (`:679`) |

The distinguishing question is not size or risk. It is whether the change alters *what counts as passing*. A 400-line refactor does not; a one-number edit does.

### 3.2 The hole in kind 3

The gap named in the kind-3 row above is the highest-value finding in this plan: the class of change most able to flatter the platform's own numbers — rewriting what counts as success — is the class with the weakest mechanical control, and it is exactly the class `platforms.md:216` singles out. Two adjacent holes compound it: a pure-documentation PR bypasses the linked-issue, lane, hashtag, §23 and CHANGELOG requirements (`docs/agents/gitops.md:1651-1659`), so a documentation-shaped evaluation change can land with no attribution at all; and no suite in `test:pins` is named for MCP scope, so the 134-tool / 6-scope table (`docs/architecture/agentic/mcp-server-inventory.md:73-87`) is not obviously frozen by anything in that list.

### 3.3 The never-list and its tripwires

The never-list is `gitops.md` §7's absolute rule, and it is broader than the five classes in this plan's brief: no adaptive behavior may expand permissions, remove approvals, raise spend, rewrite evaluation criteria, change production config, deploy, or take unauthorized financial actions, and every adaptive behavior is an explicit recorded policy with budgets (`docs/agents/gitops.md:670`). Each item and its tripwire:

| Never | Where the surface is countable | Tripwire today |
|---|---|---|
| Expand permissions | 134 tools, 6 scopes, fixed per-scope totals (`mcp-server-inventory.md:77-87`) | A scope-count assertion exists per the inventory's completeness claim (`:38-41`), but no suite of that name appears in `package.json:18` — unverified as a tripwire |
| Remove approvals | Approval tools in `mcp:trade`: `start_trade_approval`, `decide_trade_approval`, `get_trade_approval_status`, `slack_send_pre_trade_approval` (`mcp-server-inventory.md:84`) | No count pin on approval-tool presence that I can see in the named pins |
| Raise spend | `mcp:payments` 10 tools including `check_payment_budget`, `get_payment_budget`, `agentic_wallet_status` (`mcp-server-inventory.md:85`) | Budgets are enforced at the gate; no change-detector on the budget surface itself |
| Rewrite evaluation criteria | `package.json:18`; `eslint.config.mjs`; the census tests | None mechanical (see 3.2) |
| Change production config | `wrangler.jsonc`; deployment path | Workflow-file withhold covers part of this (`gitops.md:1665-1670`); config outside workflows is not covered by anything I read |
| Deploy | Outside agent authority by construction | Manual; not this plan's subject |

## 4. Measures, with an honest evidence column

`platforms.md` §6E's balanced scorecard is the ambition test, and its closing line is the discipline: no architecture, agent count, framework adoption or backtest establishes future profitability or ASI (`docs/agentic-org/platforms.md:288-303`). Below, "measured" means a number exists in a file I read; "surface" means the mechanism exists and its use is unrecorded; "unmeasured - baseline required" means no number exists and the first task is to obtain one. No figure in this table is estimated.

| Dimension (§6E) | What this repository can show today | Status | Cheapest way to obtain the baseline |
|---|---|---|---|
| Research quality — findings reproduce and survive independent challenge (`:294`) | Reproduction is enforced for code behavior (red before green, `gitops.md:564-578`) and for pinned surfaces (`:673-681`). A research or design finding has no reproduction artifact | Unmeasured - baseline required | 10 closed issues across the seven lanes (`gitops.md:1526-1532`); a second agent reproduces each headline claim from the completion report alone and records pass or fail. No tooling, no template change |
| Decision quality — evidence, assumptions and uncertainty are distinguished (`:295`) | The §15 report asks what value was created (`:651`); nothing asks which part is evidence and which is assumption | Unmeasured - baseline required | Re-read 10 completion reports and code each claim E/A/U by hand. If more than half the claims cannot be coded without asking the author, the defect is in the template, not in the reporting |
| Trading quality — survives costs, risk, liquidity, capacity (`:296`) | The trading surface is countable: 21 `mcp:trade` tools (`mcp-server-inventory.md:84`), and a trading extraction ledger pin (`package.json:18`). That is capability and boundary, not cost-adjusted performance | Unmeasured - baseline required; not obtainable from the files read | Requires the trading domain's reconciliation output, which I did not read. Do not substitute tool counts for it |
| Trust — inspect, correct, approve, stop consequential work (`:297`) | Approval machinery exists and is addressable: the four approval tools plus `alpaca_cancel_all` and the cancel family (`mcp-server-inventory.md:84`) | Surface present, behaviour unmeasured | Count `decide_trade_approval` outcomes through `get_audit_events` (`mcp:admin`, `:87`) over 30 days — one query, if audit events carry decisions, which is itself unknown |
| Reliability — recovery and reconciliation under failure (`:298`) | Detection is real: Main Audit daily with `[audit]` filing (`gitops.md:1678-1687`), stop-the-line (`:833`), quarantine runner (`package.json:19`), post-merge verification (`:1222`) | Detection measured qualitatively; recovery unmeasured | Count `[audit]` issues over 30 days and their time-to-close from the issues API. Zero new tooling |
| Economics — cost per verified useful outcome is sustainable (`:299`) | Budget surfaces exist (`check_payment_budget`, `get_payment_budget`, `agentic_wallet_status` — `mcp-server-inventory.md:85`); those are limits, not unit cost. No per-issue cost figure exists in anything I read | Unmeasured - baseline required | First check whether audit events carry tool-invocation cost at all (`get_audit_events`, `:87`). If they do not, the baseline is a build, not a query — say so rather than proxy it with issue counts |
| Governance — privileges, budgets, decisions stay enforceable (`:300`) | The strongest dimension. Five required checks on `protectmain` (`gitops.md:1563-1570`), Policy Gate field checks (`:1583-1588`), lane labels (`:1522-1550`), attribution rule (`:1688-1699`), empty bypass expectation (`:1571-1575`), 134 tools / 6 scopes (`mcp-server-inventory.md:77-78`) | Surface measured; enforcement outcome unmeasured | Two API reads: Policy Gate failures over 30 days, and ruleset audit-log bypass entries (`:1571-1573`). Both are counts, not judgements |
| Improvement — promoted changes produce independently verified net benefit (`:301`) | Nothing. Completion reports assert value; no artifact compares before and after on a measure the author did not choose (`gitops.md:651`) | Unmeasured - baseline required | The 10-issue sample in §5 phase A, with the observable named by someone other than the author. This is the dimension the plan exists to make real |

Reading the table as a whole: five of eight dimensions have no number at all, two (trust, governance) have counts of *surfaces* rather than of *outcomes*, one (reliability) has detection events but no recovery figure, and one (trading quality) is out of reach from the files this plan was allowed to read. A scorecard with five blanks is not a scorecard; it is an agenda. That is the honest state after a year of a strong delivery policy: the policy made changes attributable, not evaluable.

Three rules keep the blanks honest while they are filled.

1. **Sample before instrument.** A metric built before a baseline exists encodes the builder's assumption about what good looks like — the same error the coverage decision avoids by shipping a report with no threshold (`docs/agents/gitops.md:620-626`). Ten hand-coded cases establish whether a number is even obtainable; only then is a script justified.
2. **A measure is trustworthy when a second party can recompute it from files** — the same test as §2 step 5. Author-reported numbers, however precise, are step-5 evidence wearing step-6 clothing.
3. **Name the denominator before the numerator.** Closed issues are the only population every lane labels reliably going forward; the 1,047 unlabeled historical items (`docs/agents/gitops.md:1549-1550`) mean any rate computed over all history is a rate over a biased sample. Windows start at a declared date, not at "all time".

One dimension deserves a warning rather than a plan. Trading quality (`docs/agentic-org/platforms.md:296`) cannot be proxied by the 21 `mcp:trade` tools (`docs/architecture/agentic/mcp-server-inventory.md:84`) or by the trading extraction ledger pin (`package.json:18`); both count surfaces. If this platform ever reports trading quality from repository artifacts, it has substituted capability for outcome, which is the exact failure §6E's closing line forbids (`docs/agentic-org/platforms.md:303`).

### 4.1 Proxies this plan rejects

| Tempting proxy | What it actually measures | Why it fails §6E |
|---|---|---|
| Issues or PRs closed per week | Throughput of the paperwork | A platform can double its issue count by splitting work; §6E asks for net benefit, not activity (`docs/agentic-org/platforms.md:301`) |
| Test files or statements — 1,391 files, 14,940 statements recorded when the static gates were adopted (`docs/agents/gitops.md:603-604`) | Surface area of the suite | Adding tests is a capability change; it says nothing about whether a promoted change helped |
| Number of pins (9, `package.json:18`) | How much is frozen | A pin prevents drift; it does not produce value, and a tenth pin may protect nothing that moves |
| Tool count (134) or scope count (6, `mcp-server-inventory.md:77-78`) | Breadth of the authorized surface | Breadth is a liability as often as an asset; the never-list treats expansion as the risk (§3.3) |
| Completion reports filed | Compliance with the template | The report is required by the gate (`docs/agents/gitops.md:1583-1588`); presence is attribution, not evidence |

Every row here is cheap and available today, which is exactly why none of them belongs in §4's evidence column. The discipline §6E's closing line demands — no architecture, agent count, framework adoption or backtest proves the ambition (`docs/agentic-org/platforms.md:303`) — is easiest to keep when the rejected proxies are written down before the dashboard exists.

## 5. Phased plan

`platforms.md` §7 orders the trading value stream: governed research, then independent evaluation, then portfolio simulation, then paper and shadow, then limited live, and only last cross-platform RSI with bounded improvement portfolios and controlled promotion (`docs/agentic-org/platforms.md:305-316`). Two consequences bind this plan. First, the improvement platform is phase 2's *machinery* and phase 6's *subject*; it may build phase-2 machinery now and must not claim phase-6 evidence until phase 2's exit condition — unsupported candidates are reliably rejected (`:310`) — actually holds here. Second, phases 3 to 5 are trading-domain; this platform consumes their outputs and can never substitute for them. The phases below are therefore gates on what may be claimed, not a parallel sequence.

| Phase | Build first (maps to §7) | Exit evidence, checkable in this repository | What it does not authorize |
|---|---|---|---|
| A — Recomputable change record | Phase 1's test at repository scale: a decision packet can be reproduced (`:309`). One candidate record artifact plus a 10-issue reproduction sample | A second agent reproduces the headline claim of 10 closed issues from their completion reports alone; the pass/fail table is linked from one issue | Any change to the template or to a pin. Those are kind 3 (§3) |
| B — Protected evaluation and independent challenge | Phase 2: protected tests, experiment history, challenger review (`:310`). Protected criteria set declared out of candidates' reach; challenge record with a named non-author; coded decline reasons | Three candidates evaluated by an agent that did not author them; at least one rejected with a reason the author's own evidence could not overturn; scope totals, pin count and never-list unchanged across the window | Promotion of anything touching evaluation itself |
| C — Monitored adoption and withdrawal | Phases 4–5's discipline projected onto non-trading change: durable state, recovery, reversal (`:312-313`). A fixed-horizon post-merge check against the candidate's predicted effect, plus a withdrawal record | One change reversed on evidence and recorded; the reversal names the observable that failed and the cost of reversing | Reversal by deletion — retirement is deprecation (`gitops.md:1591-1600`) |
| D — Bounded improvement portfolio | Phase 6: bounded portfolios and controlled promotion, net improvements persist without weakening controls (`:314`) | One window in which net benefit is independently verified *and* control counts are byte-identical; otherwise the portfolio reports zero | A portfolio that excludes its own declined candidates from the denominator |

Phase D may not start before B's exit holds and C has produced at least one withdrawal. A loop that has never rejected and never reversed has not been tested; it has only been exercised.

Sizing and sequencing, so that each phase is one epic with sub-issues under `docs/agents/gitops.md:318-337` and never a program slice:

| Phase | Issues | Files touched | Wall time if unblocked |
|---|---|---|---|
| A | 3 — record artifact; 10-issue sample; write-up in the sample issue | A1: 2 new files; A2: 1 new table | 1 week |
| B | 3 — protected criteria declaration; challenge record; first three evaluations | 2 new, no `src/` | 2 weeks |
| C | 2 — post-merge check; withdrawal record | 1 new plus the record from A | 2 weeks after B |
| D | 3 — portfolio view; control-integrity assertion; window report | 2 new, 1 script | after C |

Phase A's sample is a table with five columns: issue number, the claim verbatim, the command or file that would show it, the result, and who coded it. B's evaluations reuse that shape. Nothing in A to D requires a database, a service or a dashboard; the whole program is documents and, at most, one script, which is the only size that survives a repository whose gates are documents (`docs/agents/gitops.md:1636-1649`).

### 5.1 First bounded candidate

- **Issue** `improvement: candidate record v0 — one artifact per §5 step, pinned`
- **PR** two new files: `docs/architecture/agentic/candidate-record.md` and `tests/candidate_record_schema.test.ts`.

The record is one table with nine rows, one per step of `platforms.md:185-193`, each row naming its artifact, its owner role from `agentic-roles.md:247-263`, its evidence, and — for the last row — the withdrawal condition. Beneath it, the never-list block naming every item of §3.3. Nothing else: no process, no phase gates, no scoring.

The pin asserts only what the record exists to protect (`gitops.md:679`): the nine step names each appear once, in order; each row names an artifact and an owner; the never-list block names every item of §3.3. It reads one file, so it cannot fail a PR that does not touch that file, which is the ratchet rule (`gitops.md:628-630`).

Acceptance criteria: the test fails before the document exists and passes after (§7 TDD, `gitops.md:542-598`); `npm run lint:changed` is clean on both files (`package.json:25`); the completion report states the predicted effect and what would falsify it, in its own prose, since the template has no field for either (§2 row 3).

Deliberately out of scope: adding the suite to `test:pins` (`package.json:18`), any `src/` change, any template edit, any new dependency. Adding it to the pin list is a follow-up issue after the record has been used once, so that the first candidate does not edit the list of what is frozen while being evaluated by it. The obvious alternative — adding a *predicted effect* field to the issue template — was rejected because it changes what evidence every future issue must carry, which is a governance change under `platforms.md:210-216` and belongs on the human path, not in a platform's first self-promoted slice.

Why this candidate and not something more impressive: it is the smallest artifact that makes steps 3, 5, 6 and 9 recordable, and it is falsifiable in a week — if a lane cannot fill the record for its last three merged issues from issue text alone, the artifact is overhead and phase A should be withdrawn rather than defended.

### 5.2 Sampling frame for phase A

Ten issues, chosen before any of them is read: one closed issue per lane label (`docs/agents/gitops.md:1526-1532`), plus three closed issues that changed a pinned surface, since that is where a value claim is most testable. Within each stratum, selection is by ascending issue number, not by which claims look checkable — otherwise the sample measures the sampler.

The reproduction attempt gets one hour and no contact with the author. Outcomes are pass, fail, or cannot-determine, and cannot-determine is a result rather than a deferral: it means the completion report did not carry enough to recompute the claim, which is the finding §1 predicts. A second coder re-codes three of the ten; disagreement on more than one invalidates the frame and the phase restarts with a tighter coding rule, which is cheaper than trusting a number nobody can reproduce.

## 6. Risks, and what would falsify the plan

| Risk | Mechanism | Early signal |
|---|---|---|
| The instrument becomes the work | A record nobody populates converts a measurement problem into a compliance ritual | Fewer than 3 candidates carry a complete record 30 days after A's exit |
| Independence is nominal | The same agent authors the candidate and its acceptance criteria, which `agentic-roles.md:266` forbids and nothing here enforces | Every candidate in the first month is self-evaluated |
| Prose value claims survive | The completion report is a document, not a schema (`gitops.md:651`), so a claim can stay unfalsifiable indefinitely | The 10-issue sample codes mostly "cannot determine" |
| Ratchet dilution | A new gate fires on untouched files and teaches everyone to ignore pins (`gitops.md:628-630`, `:679`) | Any red pin on a PR that did not touch the pinned surface |
| Measurement gaming | Optimizing closed-issue count or cost per issue instead of net benefit (`platforms.md:301`) | Measure moves while the independent sample does not |
| Never-list erosion by accumulation | 134 tools across 6 scopes is a count, and the pin that protects it is not in `package.json:18` | A scope-count change merges green |
| Kind-3 change slips through the weakest control | Evaluation edits are mostly non-workflow files (§3), and docs-shaped ones bypass the Policy Gate entirely (`gitops.md:1651-1659`) | A pin's expected count changes in a PR with no human approval recorded |
| This plan becomes a second rule home | It states measures and gates, which is how parallel rule sets start (`gitops.md:1636-1649`) | Any rule first written here and not in gitops |

**Falsifiers.** Each of these would show the plan is wrong, and each is cheap to test.

1. If the nine-step record cannot be populated from information already present in an issue, then the loop costs more than it returns: abandon the record and keep the completion report.
2. If no lane agent is available to evaluate another lane's candidate, §5's independent challenge cannot be implemented in this organization at all; the correct action is to escalate the role gap in `agentic-roles.md:240-267`, never to simulate independence.
3. If a bounded candidate's measured effect is indistinguishable from noise on the only surfaces this repository measures continuously — pin pass/fail and the lint count — then "improvement" is not measurable at this scale, and the honest output is a withdrawal record.
4. If phase B cannot demonstrate a rejection, phase D is theatre and must not start, whatever the portfolio table would show.
5. If a scope-count or never-list change can be merged green today, then governance — the one dimension §4 scores as strong — is measuring the wrong thing, and the plan's order is wrong: fix that gate before building any record.
6. If more than half the sampled completion reports turn out to contain a falsifiable claim already, the diagnosis in §1 is too pessimistic and the platform needs sampling, not new artifacts.

**Decisions this plan surfaces and does not take.** Three, all owner-side, each a consequence of §3.2: whether a kind-3 change should gain a mechanical withhold so evaluation edits cannot merge on green alone; whether the pure-documentation bypass (`docs/agents/gitops.md:1651-1659`) should keep applying to documents that define evaluation, since a docs-only PR can today redefine a measure with no issue, lane or hashtag; and whether the candidate record joins `package.json:18` after its first use — a pin-list edit, and therefore kind 3 by this plan's own classification. None of the three is settled here, because each changes the rules the platform is judged by.

**What this plan deliberately does not do.** It does not amend `docs/agents/gitops.md` — the two gaps it finds (kind-3 changes have no mechanical withhold; documentation-shaped evaluation changes bypass the gate) are reported here for their owners to decide, because a plan that fixes the rulebook it is judged by is the failure mode the rulebook warns about (`docs/agentic-org/platforms.md:216`). It does not build a dashboard: a dashboard over unverified numbers is a more convincing version of the status quo. It does not score lanes against each other, because lane labels are attribution, not performance (`docs/agents/gitops.md:1688-1699`), and a per-lane ranking over a 23% backfilled label (`:1549-1550`) would be a ranking of who tags their work. It does not touch trading behavior, deployment or spend.

**Review point.** Re-read this plan at the first phase exit, or on 2026-12-11, whichever comes first, and record the outcome in the issue that produced the exit evidence — not in a new document. If phase A has not exited by then, the correct revision is to cut the record to whatever the sample could actually fill.
