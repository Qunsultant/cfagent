### The OODA dispatch writes the D1 stage-event mirror (#6388)

- The dispatch control now carries `stageEventsMirror`, exactly as the stage-control and read paths already did. Before this, a dispatch-path run wrote its terminal stage rows to the DO only, so the D1 fallback the stage read relies on (#6202) was empty for every such run — and a `d1-only` reader saw no stages at all.
- No new store, no new route: the same `createD1JobStageEventStore(d1)` adapter, on the engine's existing best-effort mirror write. No `d1` binding still means no mirror — never a throw.
- The read still prefers the DO and falls back to D1 only when the DO has nothing for the run, so the mirror can never shadow a fresher row; the mirror's `(run_id, stage_id)` upsert keeps a re-settled run idempotent on both planes.
