# Schedules surface: one row per schedule (UX pattern 01)

| Field | Value |
|---|---|
| Status | Implemented (issue #2329; row controls, sorting and filters #4389) |
| Scope | The Schedules tab (`SchedulesPanel` → `ScheduledOptionsManager` / `ScheduledOptionsSection`) |
| Governs | `docs/agents/ux-architecture.md` §6 (primitives, tokens) and §20 (definition of done) |
| Pins | `tests/schedule_rows_2329.test.tsx`, `tests/schedule_ui_s7.test.tsx`, `tests/scheduled_options_manager.test.ts`, `tests/schedules_panel.test.tsx`, `tests/schedule_list_controls_4389.test.ts` |

## Decision

A schedule is rendered as **one table row**, not a card. The row carries the
facts a reader scans for, and every action sits in that row's single actions
cell:

| Column | Contents |
|---|---|
| Schedule | Job name + kind/model/cadence-type badges (never the status) |
| Schedule ID | The **full** id (monospace, wrapping, selectable) — never a truncated snippet |
| Cadence | `cadenceText` (e.g. `Every 60 min`) + next run |
| Status | `Active` / `Paused` as its own column (#4389), one badge, one vocabulary |
| Scope | One-line target summary + owner · environment |
| Actions | `Edit`, `Details`, `Trigger Now`, `Pause`/`Resume`, `Delete` |

The table scrolls horizontally on narrow viewports instead of clipping the id
or the actions.

## One button set, one vocabulary

Every row — screening, generic, and the ticker push's live feed — carries the
same five controls, in this order and with these words (#4389):

```text
Edit · Details · Trigger Now · Pause | Resume · Delete
```

No kind gets a shorter list, a second word for a control, or a badge standing
in for one. `Edit` opens the row's own editor: a screening row's schedule form
(`ScheduleFormModal`, which already owns cadence), any other row's cadence
dialog (`CadenceModal`). `Details` opens the one details dialog for every kind;
the live feed's details are served by the feed's own Durable Object, not a
second store read. `Trigger Now` runs the row now — for the live feed, one
immediate push. `Delete` removes the row; on a live feed there is no stored
definition, so the action stops the push and the confirmation says exactly
that, with **Resume** named as the way back.

## One cadence dialog, capability-aware

`CadenceModal` is the only cadence editor for rows without a structured form.
It offers what the row can actually do (#4389): a live feed runs on an
interval, so its dialog shows the interval presets only — no cron preset, no
cron field, no Apply-cron — plus one line saying why cron is absent. A
cron-capable row sees the dialog unchanged. A screen can therefore never
present a choice the route will refuse.

## Sortable headers, one status filter

- Every column header except Actions is a button (#4389). A first click sorts
  ascending, a second descending; the header shows its direction and its cell
  carries `aria-sort`. The ordering rule lives once in `src/client/tableSort.ts`:
  numbers compare numerically, strings locale-aware, blanks last in both
  directions, ties keep the caller's order.
- The toolbar carries a second filter dimension beside the kinds: **All
  statuses · Active · Paused**, composing with the kind (`Options + Paused`).
  The vocabulary and its configuration live in
  `src/config/scheduleListModes.ts` (`SCHEDULE_LIST_STATUSES`), like the kinds.

## One create action, one refresh

- The page has exactly **one** create action: the screening hero's
  `+ New Schedule`. The duplicate `＋ New schedule` button in the tab row was
  removed with the `openCreateSignal` host signal it drove.
- The page has exactly **one** refresh control: the tab row's `↻ Refresh`. It
  refetches the panel's list, the screening list, the latest runs, and the
  audit trail (one `refreshSignal` bump).

## Confirmation

Destructive actions confirm in `ConfirmModal` (one dialog, `Modal` primitive)
that names the job and the id and states that the action cannot be undone. No
native `confirm()`/`alert()` (see #2283).

## What this does not change

No store, payload, or notification behaviour changes. The one addition on the
API surface is the live feed's own detail and trigger hops, which go through its
Durable Object behind the actor-gateway port (ADR 0029 D-0); deleting a live
feed cancels the push rather than removing a definition. The create/edit
payload builders and the pause/resume routes are untouched and remain pinned by
their existing tests.
