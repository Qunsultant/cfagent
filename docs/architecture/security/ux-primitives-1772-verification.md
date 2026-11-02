# UX primitives #1772 — re-audit verification record

**Issue:** Qunsultant/cfagent#1772 (parent #1717, source row F-53)
**Audit source:** `docs/architecture/UX/exceptions-01.md` (44 exception files:
28 zero-primitive + 16 partial)
**Re-audit base:** main `6245be52` (2026-11-02)
**Lane:** #CISO-bhdm

## Method

TypeScript-AST count of raw JSX controls per file, same control set as the
#1580 freeze (`button`, `input`, `select`, `textarea`, `table`; `th`/`td`/`tr`
subsumed by `table`; `form` and `dialog` excluded per #1580 v1 scope),
plus a check that each file imports a `src/client/components/ui/` primitive
(a `components/ui/*` path or the `./ui` barrel). Comment and string-literal
mentions of raw tags do not count (AST, not grep): the only two regex-level
hits on current main are comments (`CorpusTab.tsx` line 79,
`ScreenerResultsView.tsx` line 224).

## Result: 44 / 44 converted, 0 remainders

- Zero-primitive list: 28 files, each 0 raw controls, each importing a ui
  primitive.
- Partial list: 16 files, each 0 raw controls, each importing a ui primitive.
- Whole-`src/client/` scan (135 `.tsx` files outside `components/ui/`):
  0 raw-control offenders.
- #1580 freeze allowlist (`tests/ux_primitive_usage_allowlist_1580.json`):
  empty (`{"files": {}}`), so no exception is carried as an allowlist entry.

## Count reconciliation (28, not 30)

The doc's Category 1 enumerates 30 files, but two of them are carried in
the doc's own Category 3 compliant list: `SchedulesPanel.tsx` (resolved
2026-10-29 by #2329) and `PartnerDealsModal.tsx` (uses the Modal
primitive). 30 − 2 = 28 zero-primitive; 28 + 16 partial = the 44 this
issue names. Both Category 3 files were re-checked and are also at
0 raw controls with a ui import, so the full doc enumeration (46 files)
is compliant and nothing is dropped by the arithmetic.

## Phases 1–3 disposition

Phases 1 (high-visibility/reference), 2 (core workspace/chat) and 3
(high-volume domain panels) close as **verified-done, not rebuilt**: the
conversions landed through prior work before this slice, and rebuilding
already-converted files would be churn with regression risk and no
behavior change. The durable evidence is the named 44-file pin test
(`tests/ux_primitives_exceptions_1772.test.ts`), which fails by file
name on any regression. No file was deleted, renamed, or removed from
an export by this slice.

## Phase 4 (separate PR)

The live CI enforcement pin is the #1580 freeze test, green on main
with an empty allowlist. It was proved, not asserted, by a negative
probe run on the audit base: a temporary `src/client/__1772_pin_probe.tsx`
rendering one raw `<button>` failed the freeze test with
"NEW raw controls: src/client/__1772_pin_probe.tsx renders 1 raw
control(s) but is not in the allowlist"; the probe was removed and the
freeze test returned to green. #1772's Phase 4 follow-up PR adds a
permanent negative test for that pin mechanism.

## Remainders

None. No file is carried forward with a reason, because no file
remains non-conforming under the pin's control set.
