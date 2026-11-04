# Run recovery: replay vs regenerate (and the stock in-place re-render)

**Status:** record of the three recovery paths an options/stock run has, so the
choice is not re-argued per incident and not left in a completion report.
Related: #2863 (replay), #2603 (options regenerate), #1325 (stock PDF
re-render), #2764 (the fail-loud preset rule these paths share).

## The three paths

| | **Replay** | **Regenerate** | **In-place re-render** (stock) |
|---|---|---|---|
| Endpoint | `POST /api/reports/replay` | `POST /api/trading/options/regenerate` | `POST /api/screener/report/regenerate` |
| Question it answers | "show me exactly what this run saw" | "do this same request again" | "redraw this run's PDF" |
| Input | the persisted canonical record only | the persisted record → rebuilt request, executed live | the stored run's result in DO storage |
| Executes the screen? | **no** — the signature takes the stored body; no provider, fetch or engine | **yes** — the unified executor, exactly as a manual run | **no** — re-renders one artifact |
| Cost | none (no re-charge, by construction) | a normal run | none |
| Writes | nothing: no new canonical row, no job, no workflow | a **new** canonical row under its own generation id; the original is untouched | rewrites the latest row's PDF in place |
| Identity | provenance back to the original (`originalRunId`, `replayedAt`) | a new run carrying `regeneratedFrom` / `regeneratedAt` / `regeneratedBy` | the same row |
| When data is incomplete | replays with `partial: true` + per-gap reasons; missing record → 404/422 | refuses with 422 naming the stored fields it cannot rebuild | n/a |
| Use it when | audit, evidence, reproducibility | a failed artifact leg, or the same thesis/symbols on fresh data | the renderer was the only thing broken |

## The rule that connects them

All three obey the same rule (#2764, applied to options in #2604): **the system
never quietly produces a different report than the one recorded.** Replay marks
partial instead of filling gaps with live data; regenerate refuses an
unhonourable stored scope or an unrebuildable request instead of guessing;
the in-place re-render touches one artifact and no numbers.

## UI entry points

- Replay: Stock Hub run detail → **Replay this report** (`?tab=stock-hub&view=stocks`).
- Regenerate: the run detail's **Regenerate this run** action, rendered when the
  caller can name the stored options run (`RunDetailView`'s `regenerateRunId`).
- In-place re-render: the Reports row's **Regenerate** action for a failed PDF
  (`RegeneratePdfButton`).

## Known gaps

- The options regenerate action is not yet wired to a mounted call site: the
  component prop exists and the endpoint is live, but the one consumer that
  mounts `RunDetailView` (`StockHub.tsx`) passes `replayRunId` only. Wiring it
  there is the follow-up.
- Regenerate re-fetches live data by design; anyone wanting the recorded numbers
  must use replay.
