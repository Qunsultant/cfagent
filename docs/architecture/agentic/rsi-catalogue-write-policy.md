# RSI catalogue write policy: what an agent may add, and what it may not

**Status:** decided (2026-11-18) — issue #5063, gap AG-9.
**Scope:** pattern, preset, and skill catalogues; the surfaces an RSI loop would
have to extend to gain a capability without a human writing code.

## Decision

An agent may **not** write into the pattern, preset, or skill catalogues.
There is no governed path for it today, and this record states why rather than
leaving the gap silent. The capability an RSI loop actually has is narrower and
is stated below.

This is a decision-not-to, reviewed against the champion/challenger model the
issue proposed. It is revisited when #5502 (the Self-RSI sandbox synthesis
pipeline) lands, because that is the missing precondition — see
"Revisit trigger".

## What exists today, and why no write path

| Surface | What it is | Who writes it | Why no agent write path |
|---|---|---|---|
| Patterns | `src/services/patternSignals.ts` — pure functions over bars (`SandboxStrategyId` identifies each) | Humans, in code, through a PR | A new pattern is new code. An agent that could write it would need code synthesis plus a sandbox that executes it — the §7 pipeline, which is specified-only (#5056, `self_rsi_pipeline` in `src/services/stockCopilotRsiCapabilities.ts`) |
| Presets | `src/data/doSqliteScreenerPresetAdapter.ts`, routes in `src/agents/routes/screenerPresets.ts` | The user, through the screens they own | A preset is user configuration, not platform capability. An agent writing one would silently change what a named screen means to its owner |
| Skills | No skill files exist under `src/` | — | Nothing to write into; creating a skill store to hold agent-authored skills would be a new substrate with no consumer |

The "self-improvement" surface therefore has no catalogue write path, and that
is the honest boundary of what the loop can do: it proposes, it does not create.

## What the loop can actually do (the real promotion paths)

1. **Propose a capability.** `synthesizeCapabilityProposals`
   (`src/services/stockCopilotIntrospection.ts`) drafts a governed pathway —
   issue title, lane, actionable plan — and, since #5057, can file it as a §5
   task issue after an explicit human approval
   (`src/services/stockCopilotProposalFiling.ts`). This is the path a new
   pattern takes today: a human reads the proposal and writes the code.
2. **Propose a weight change.** `championChallenger.ts` + the v2 weights policy
   (`src/services/strategyWeightsV2.ts`) is the one parameterisable surface: a
   proposal carries frozen evidence, the apply path goes through
   `applyAdaptation` (budget, kill switch, append-only audit), and no change
   reaches live ranking without the gate. The weights are the model's
   parameters; the catalogue is its code.
3. **Record what it learned.** `mas_learnings` (reflection, human corrections,
   judge scores since #5058, promoted memory facts since #5060) is where an
   agent's conclusions live — evidence for a human decision, never a
   behavioural change by themselves.

A fourth path — agents writing a new pattern, preset, or skill — would need all
three of: code synthesis with a sandbox that runs it (#5502), frozen evidence
that the new capability beats the incumbent, and a human approval with an audit
trail. Only the last two exist (they are the champion/challenger gate); the
first does not.

## Revisit trigger

When #5502 lands `self_rsi_pipeline` as `implemented`, this decision is
re-opened with a design for a governed catalogue promotion path modelled on
`championChallenger.ts`:

- a candidate pattern card carries frozen evidence (the backtest that justifies
  it) and a falsification criterion;
- promotion requires the human gate, recorded as a decision row;
- every applied change writes an append-only version record naming what it
  superseded;
- the registry entry (`self_rsi_pipeline`) is what makes the mode switch real,
  so the policy and the switch move together.

Until then, any issue that proposes an agent-written catalogue entry is
blocked by this record, not by an unwritten rule.

## Evidence

- `src/services/patternSignals.ts` — pure functions; no writer.
- `src/data/doSqliteScreenerPresetAdapter.ts:39`; `src/agents/routes/screenerPresets.ts` — presets are user-written.
- Absence grep for a pattern/preset/skill writer in `src/`.
- `docs/architecture/agentic/stockcopilot-RSI.md` §3.1 and §7 (status block).
- `src/services/stockCopilotRsiCapabilities.ts` — `self_rsi_pipeline` = `specified_only`.
- `src/services/championChallenger.ts`; `src/services/strategyWeightsV2.ts` — the existing governed promotion model.
