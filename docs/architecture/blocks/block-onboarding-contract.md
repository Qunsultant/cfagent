# Block onboarding contract (#2991, #2770 Phase A)

The product surface by which a capability onboards onto the
workflow platform. A capability onboards only when it provides
every piece below; the contract is enforced in code by
`src/workflows/blocks/blockContract.ts` (`defineBlock` throws on
a missing piece, `assertBlockConforms` checks an implementation
carries its port, `validateComposition` checks a composition's
refs, gates, and terminals).

## What a capability must provide

1. **Port interface** — the methods a caller uses (e.g.
   `startLeg` / `getLegStatus`, `run` / `withdraw`).
2. **Input/output schemas** — descriptor data (field name, type,
   required). Engines keep their own zod schemas; the Block
   descriptor is the platform's view of them, not a second
   validation language.
3. **Stage contract** — the stage ids the capability emits, and
   terminal semantics: each terminal mapped to an outcome catalog
   code. Wiring capabilities (disclosure) declare stages and no
   terminals — they ride another row.
4. **Tests** — the capability's behavior pinned standalone, plus
   composition tests proving the composer runs on it.
5. **Outcome-catalog entries** — every terminal resolves via
   `resolveOutcome` (the #2381 pin: `outcomes` keys must match
   SUCCESS|FAILURE with full outcome fields; notice/alert texts
   are not outcomes and live in `channelTemplates`).
6. **Governed promotion (§5)** — candidate → isolated evaluation
   → authorized promotion → monitored adoption, recorded on the
   definition.

## The saga as reference implementation

| Block | Kind | Port |
| --- | --- | --- |
| payment-leg, screener-leg, trade-leg | leg | leg registry (`legPortFromRegistry`) |
| journey-gate | gate | `runJourneyGateCapability` |
| compensation | compensation | `compensateFailedScreen` |
| disclosure | disclosure | `sagaCompensationDisclosure` |
| outcome-notice | notice | `buildSagaOutcomeNotice` / `postSlackSagaOutcome` |
| stock-leg, options-leg | leg | planner port + provider seam |

The saga flow file (`sagaWorkflowFlow.ts`) is the thin composer:
ordered Block refs + branch conditions + delegation calls. It
owns no leg logic, gate logic, compensation logic, prompt copy,
decision parsing, refund/credit logic, Slack posting, or notice
rendering — all of which live in capability modules.

## Leg composition (broker-vs-goal)

A goal screen IS a composition of stock-leg + options-leg Blocks;
a broker single-asset screen IS one leg Block — same legs, same
stages, same contracts. Structure selection (taxonomy structures)
is plan-time input to the options leg, not an execution leg.

## Uniformity rule

Behavior and implementation are consistent across ALL execution
modes. A mode changes only timing/transport (wait vs poll,
in-process vs queued), never behavior. Where full unification
needs another lane's work, the dependency is named in
`uniformExecution.ts` (`UNIFORMITY_DEPENDENCIES`) — never built
as a parallel pipeline, never taken from another lane.

## What Phase B adds

The Phase B registry: governed registration, discovery, and
versioning of Blocks beyond the saga's. Phase A delivers the
contract + the saga's decomposed capabilities; the registry
itself is NOT in this slice.
