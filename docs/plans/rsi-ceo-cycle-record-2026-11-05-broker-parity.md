# RSI-CEO — Cycle Record: Broker Parity, 2026-11-05

_Author: `#ceo-aimp` · Domain: [`platforms.md`](../agentic-org/platforms.md) §1 (CEO — organization and strategy platform), §5 (governed RSI) · Extends: [`rsi-ceo-portfolio-plan-2026-11-05.md`](rsi-ceo-portfolio-plan-2026-11-05.md) · Mission contract: [`mission.md`](../agentic-org/mission.md) §4, §6_

Status: **cycle complete, register evidence collected**. This record is the second of the three records mission §6 requires: `cycle 1 result → explains cycle 2 selection`. It does not replace the register (the plan's candidate 1); it is the evidence that candidate needs.

## 1. What this cycle was asked to do

The owner's instruction was one sentence: bring E*TRADE and Alpaca to **full parity**, including UX and sign-in for Alpaca, and finish the work already in flight. That is a program-shaped request, not an issue, so the first job was turning it into countable work — and the second was refusing to round the result up.

## 2. What was delivered, with evidence

| Issue | Capability | State | Evidence |
|---|---|---|---|
| #3326 | IV history records the broker whose chain measured it; each broker's series is served only under the broker that produced it | **merged** | PR #3347 → `da0a5de2`, merged 18:03Z |
| #3327 | Scan history records the broker whose chains produced the run; profiles stay per-user (configuration, not observation) | **merged** | PR #3348, merged 18:17Z |
| #3331 | A screener report names the broker and mode that produced it; legacy runs keep the wording of the broker that actually produced them | **merged** | PR #3349 |
| #3351 | Alpaca sign-in: the user's own key pair, verified before storage, stored per user and per trading type, with the source named on every status read | **in review** | PR #3355 |
| #3356 | Portfolio risk follows the catalogue's declaration and the selected broker's book instead of the E*TRADE name | **in review** | PR #3358 |

Supporting decisions worth recording, because each one rejected a plausible shortcut:

- **Provenance over relabelling** (#3326, #3327, #3331). Every route to "show Alpaca's data" that would have been cheap — deriving a series from one snapshot, relabelling legacy rows, stamping today's selection onto yesterday's run — was rejected as fabrication. Legacy rows read as E*TRADE because E*TRADE produced them.
- **Verify before store** (#3351). A stored credential is a claim that it works; the pair is proven against Alpaca's own `/v2/account` for the trading type the platform will actually use, and a refusal stores nothing.
- **No silent default to paper** (#3351). `credentialSource: "none"` is a state. A live selection with no live pair says so instead of quietly trading paper.
- **E*TRADE keeps its own risk routes** (#3356). Moving it onto the neutral route without an equivalence proof would have been a behaviour change dressed as a refactor.
- **Named absence over emulation** (#3356). Hedge, repair, bundle and guardrail drafts are E*TRADE features; for another broker they are never requested and each says why, rather than rendering an empty section or an error.

## 3. What is *not* at parity, stated rather than rounded up

The account panels — orders, transactions, watchlists — are still E*TRADE-only (`AccountPanels` calls `/api/etrade/*`; `AlpacaBrokerPanel` renders accounts and positions). Calling the parity claim complete while that is true is exactly the failure this cycle was cleaning up, so it is recorded here as the **first row the register should carry as `blocked` with no blocker named** — which, by the plan's own rule ("an unnamed blocker is not a blocker"), makes it `proposed` and eligible for the next cycle.

## 4. Evidence for the plan's own hypotheses

The plan (F1) claims: *"the portfolio is written as prose and decays within days."* This cycle produced a direct test of that claim, in this program's own documents:

- Issue **#3306**'s "Current state (verified on main 2026-11-05)" section states that "Connect is verify-only for Alpaca" and implies the scanner has no neutral backend. Within the same day, #3351 made connect a real sign-in and #3327 made the scanner broker-scoped. The section was accurate when written and wrong by the evening.
- The three parity PRs themselves carried **five** assertions that went stale as their own change landed (census counts in `options_discovery_step2_census_2337`, `ux_conformance_gates_3047`, `thin_router_inventory`, `global_dd_census_2356` ×2). Each was a *pin*, and each was updated in the same PR rather than silenced — which is the pin rule working, not failing. But it is also the measured cost of prose status: every count is a claim that must be maintained.

**Consequence for candidate 1.** The register should not restate capability state that a test already pins (those cannot drift), and it *must* carry the state that no test pins (which panels a broker has). That distinction was not in the plan's five rules; it is an addition this cycle earned.

**Consequence for C2** (outcome field in the §15 report): this cycle's outcomes are already `not-yet-observable` — the parity claims need a live Alpaca session to be observed, not a green suite. That is precisely the row C2 exists to make visible, and it is the argument for promoting C2 rather than deferring it again.

## 5. Flow and truth measurements (this cycle)

| Measure | Value | How measured |
|---|---|---|
| Issues closed this cycle | 3 (#3326, #3327, #3331) | `gh issue list --state closed` |
| Slices opened for review | 2 (#3351, #3356) | `gh pr list` |
| Pin assertions moved by these changes | 7 | PR diffs |
| Product defects found by the pins | 1 (a route importing a trading-internal path, #3351) | `tests/trading-boundary.test.ts` |
| Stale prose claims found | 2 (#3306 current-state; the plan's own F1 samples) | issue text vs merged state |
| Deletions | 0 | Policy Gate §22 |

The single most useful number is the fourth: the boundary test caught real architecture drift that review would plausibly have missed. That is enforcement earning its keep, and it is why this record claims a fixed defect rather than a clean review.

## 6. Next-cycle selection (per the plan §8)

The plan's rule: choose the row `blocked` longest with a named blocker, else the row with the most cycles and no evidence; if neither exists, **no new cycle**.

By that rule the next cycle is:

1. **Account-panel parity** (#3359) — the only surface where a broker still silently lacks what the other has. `proposed`, no blocker.
2. **C2 promotion** — an outcome field on the §15 report, now argued by a concrete example rather than a principle. This is a governance-template change and remains a human-approval item (platforms.md §5); this record supplies the evidence, it does not approve it.

Nothing else is promoted. The parity program's remaining rows are behind those two, and inventing a third would be the busy-and-unverifiable outcome the plan names as worse than idle.

## 7. Authority

Unchanged from the plan §7. This record makes no governance change: it adds measurements and one candidate ordering. Repository settings, governance templates, live trading, and risk limits remain outside this platform's authority.
