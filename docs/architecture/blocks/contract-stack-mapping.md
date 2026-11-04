# Contract-stack mapping (#2991, #2770 Phase A)

One layered contract stack. The historical contracts map onto it
exactly once each (enforced in code by
`src/workflows/blocks/contractStack.ts`).

```
intent -> plan -> execution command -> stage messages ->
persisted results -> reports
```

## The mapping

| Contract | Layer | Disposition |
| --- | --- | --- |
| parseStockScreenRequest, parseOptionsScreenRequest | intent | canonical (the intent parsers) |
| GoalScreenPlan | intent | thin-view (goal intent → plan input) |
| StockScreenRunSpec, StockScreenPlan, optionsPlanBlock | plan | canonical |
| ScreenerRunRequest | executionCommand | thin-view (sync view; canonical is WorkflowJobCommand) |
| WorkflowJobCommand | executionCommand | canonical |
| StageMessage (#2869) | stageMessages | canonical (stock stages named once) |
| AsyncJob | stageMessages | canonical (carrier) |
| ScreeningProviderRegistry | executionCommand | canonical (provider seam) |
| ScreenerAgent.runScreen | executionCommand | thin-view (sync executor; per-boundary emission is #2869 follow-up) |
| DynamicOptionsScreener | executionCommand | canonical (options execution seam, wrapped by the options leg) |
| mas_reports + mas_data_captures + ledger | persistedResults | canonical |
| mas_events saga audit rows | persistedResults | canonical (the only audit system) |
| outcomeCatalog + channelTemplates | reports | canonical |
| goal reports + Docs + delivery | reports | canonical |
| broker goal guard | plan | RETIRED by #2991 |
| goal-dispatch parallel execution | executionCommand | retire-follow-up (goal-dispatch migration slice) |
| sync-only options path | executionCommand | retire-follow-up (options funneling slice) |

## Retirements

Retirement is never a silent deletion (Policy Gate: no file
deletions; retire by deprecating in place with a named
successor). The broker goal guard is retired IN this slice
(a removed branch + an updated pin, not a file deletion). The
two retire-follow-ups are their own slices with their own
batteries — this slice only names them and enables the first
(guard retirement) of them.

## The #2989 seam interaction

The leg registry derives instance ids but persists nothing.
The ACTUAL id used at start (derived or fallback) is the
correlation carrier; persisting it onto job records is #2989's
uniform correlation seam (in flight in another worktree). This
slice accepts the correlation id through the port and never
derives a second one.
