# Template gate + bespoke-layout freeze (#3136)

Part of #2150 (template program), slice #3136 — route→template gate +
bespoke-layout freeze (Phase 2). Freeze-first: the gate lands green on
day one and ratchets forward; it never ships red.

## The two halves

1. **Route→template gate** — every nav route has a template state in
   the `template` key of `tests/ux_shell_exceptions_3047.json`, verified
   against the source by `tests/template_conformance_3136.test.ts`.
   States: `template` (renders `<PageTemplate`), `shell` (renders
   `<PageShell`, migrates later), `hub` (renders inside the trading
   hub's PageShell wrapper), `chat-inline` (inline `TAB_CONTENT` entry
   in `Chat.tsx`, inside Chat's PageShell), `exception` (not a page —
   only `chat` today).
2. **Bespoke-layout freeze** — no NEW bespoke layout class may appear;
   the grandfathered list in `tests/ux_layout_freeze_3136.json` is the
   complete set at freeze time. Enforced by the `#3136` section of
   `tests/ux_conformance_gates_3047.test.ts`.

## Definition: what counts as a bespoke layout class

A non-primitive class rule whose declarations include a **layout
property** — exactly this set:

- `display: grid | flex | inline-grid | inline-flex`
- `grid-template`, `grid-template-columns`, `grid-template-rows`,
  `grid-template-areas`
- `flex-direction`
- `grid-column`, `grid-row`
- `position: absolute | fixed`

Non-primitive means defined outside the primitive library: every
`.css` file under `src/client/` **except** `tokens.css` (the token
source) and `src/client/components/ui/primitives.css` (the primitive
library itself). 25 sheets are scanned.

Target-based: only the **last simple selector** of each comma part is
the rule's subject. `.a .b { display: flex }` freezes `.b`, not `.a`;
`.a, .b { display: flex }` freezes both. Rules inside `@media`
blocks are scanned like any other (the scanner finds the inner rules).

## Measurement (base: post-#3135 main `1dc4a859`)

- **1,185 grandfathered classes** across the 25 scanned sheets.
  Largest sheets: `styles.css` 542, `options/strategyDiscovery.css`
  223, `options/flows/optionsFlows.css` 68, `workflowsHub.css` 58,
  `optionsResearch.css` 52, `options/optionsResearch.css` 52.
  51 classes are defined in more than one file.
- **Correction to the #3136 discussion brief.** The brief said "487"
  for `styles.css`. That number is a **rule** count under a
  single-class-selector regex (`\.name\s*\{`), reproduced exactly on
  this tree. The freeze pins **classes** in any selector form (comma
  selectors, compound/descendant subjects), which is 542 in
  `styles.css` and 1,185 total. The freeze design is unchanged — only
  the baseline size was under-counted. A broader property set (adding
  `gap`, `align-*`, `justify-*`, `flex`, `place-*`, `flex-wrap`,
  `grid-area`, `grid-auto-flow`) finds 1,254 classes — 69 more that
  carry only those properties. The freeze deliberately uses the narrow
  set; extending it is a future slice, not this one.
- **Template states (44 routes):** 1 `template` (risk-analysis), 23
  `shell`, 17 `hub`, 2 `chat-inline` (audit, nlq), 1 `exception`
  (chat). Only `src/client/RiskAnalysisPanel.tsx` renders
  `<PageTemplate` — verified, still the only one. 37 files render
  `<PageShell`; the hub wraps the 17 trading routes.

## Wave assignment

Each grandfathered class carries the slice that burns it down:

| Wave | Rule | Count |
|---|---|---|
| wave-1 (#3138–#3140) | `order-*`, `autopilot-*`, `executive-kpi-*` prefixes (any file), or defined in `optionsResearch.css` (either copy, #3139) | 69 |
| S-U4 | `workflowRuns.css` | 20 |
| S-U5 | `dataProvidersPanel.css`, `serviceTokensPanel.css`, `apiKeysPanel.css`, `loggedInUsersPanel.css`, `roleGrantsPanel.css`, `agenticWalletPanel.css`, `accountPanels.css`, `agentsPanel.css`, `docsAndReports.css`, `iaaaAdminPanel.css` | 83 |
| S-U6 | `reports.css`, `scannerPanel.css`, `portfolioRiskPanel.css`, `stockCopilotPanel.css` | 56 |
| S-U7 | `styles.css` (shared sheet), `options/strategyDiscovery.css`, `workflowsHub.css` | 807 |
| S-U8 | `options/flows/optionsFlows.css`, `scheduledOptions.css`, `chat/optionsCard.css`, `researchReports.css` | 114 |
| S-U9 | `options/riskAnalysis.css` | 36 |

Multi-file classes (51) take the **earliest** wave among their
defining files (wave-1 < S-U4 < … < S-U9). The entry's `file` is the
defining file with the earliest wave (alphabetical tie-break); `files`
lists all defining files when there is more than one.

Template-register waves use the same slices, by surface owner
(#3695 plan): S-U4 chat marketing + billing; S-U5 platform/ops;
S-U6 trading hub host + order surfaces; S-U8 catalog-vs-tool duals
(options-screener, options-flows, research); wave-1 order (#3138),
options (#3139), autopilot (#3140). Six routes are `unassigned`
(search, checkout, products, payment-assurance, audit, nlq) — no
slice owns those surfaces yet; the wave is assigned when a migration
slice is filed. `workflows` / `workflow-catalog` are S-U4 by family
(sibling WorkflowRunsPanel is S-U4) — a judgment call, recorded here.

## Borderline calls

- **Component-internal flex rows are frozen.** The definition is
  mechanical (property-based): a button row inside a card
  (`.card-actions { display: flex }`) is a layout class and is
  grandfathered like any other. The page-vs-component distinction
  does not exempt a class; it only affects which slice burns it.
- **`ui-modal-body` (styles.css) is a namespace collision, not a
  primitive.** It shares the `ui-` prefix but is defined only in
  `styles.css` (`:10275`, `.stock-search-modal-dialog .ui-modal-body`)
  — `primitives.css` does not define it. Grandfathered S-U7. If a
  `ui-modal-body` primitive ever lands, this rule must be removed
  first.
- **`display: block` / `contents`, `position: sticky` / `relative`,
  and `gap` / `align-*` / `justify-*` alone are NOT freeze triggers.**
  Only the narrow property set above freezes a class. A rule with
  only `gap: 8px` is not a layout class under this definition.
- **Duplicate definitions stay frozen in every file.** 51 classes
  are defined in more than one file (e.g. both `optionsResearch.css`
  copies); all definitions must go before the entry can be removed.
- **RiskAnalysisPanel's own sheet is frozen but unloaded.** The
  panel imports no CSS and has zero `className` occurrences, yet
  `options/riskAnalysis.css` still carries 36 layout classes.
  They are grandfathered S-U9 (the panel's slice) and die when the
  sheet is deleted, not before.

## Burn-down procedure

- **Delete a class:** remove the rule from its stylesheet(s) **and**
  its entry from `tests/ux_layout_freeze_3136.json` in the same PR.
  Removing the entry alone fails (the class is still scanned);
  removing the class alone fails (stale entry).
- **Add a class:** any layout class outside the list fails CI. Build
  from `src/client/components/ui/` primitives instead; if a new
  bespoke class is genuinely needed, the freeze definition itself
  must change in a dedicated PR — never silently extend the list.
- **Flip a route to template:** render `<PageTemplate` in the panel
  file, change its register entry to `state: "template"` (drop the
  wave), and extend `CONFORMING_TEMPLATE_ROUTES` in
  `tests/template_conformance_3136.test.ts` in the same PR.
- **Reassign a wave:** edit the entry's `wave` (freeze JSON) or the
  register entry (template register) with the reason in the PR body.
