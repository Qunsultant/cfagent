# Template gate + bespoke-class freeze (#3136)

Part of #2150 (template program), slice #3136 — route→template gate +
bespoke-class freeze (Phase 2, tightened S-U4 #4820). Freeze-first: the gate lands green on
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
2. **Bespoke-class freeze** — no NEW bespoke class may appear;
   the grandfathered list in `tests/ux_layout_freeze_3136.json` is the
   complete set at freeze time. Enforced by the `#3136` section of
   `tests/ux_conformance_gates_3047.test.ts`.

## Definition: what counts as a bespoke class

Any class rule outside the primitive library — layout or not. The
#3136 freeze first covered only classes whose declarations include a
**layout property** (display grid/flex, grid-template-*, flex-direction,
grid-column/row, position absolute/fixed); S-U4 (#4820, the first slice
under the zero-bespoke rule) tightened it to **every** non-`ui-` class
rule, because a bespoke color, font, or radius is bespoke all the same.
The layout-property filter is gone from the scanner; the grandfathered
list now holds every class the sheets define.

Non-primitive means defined outside the primitive library: every
`.css` file under `src/client/` **except** `tokens.css` (the token
source) and `src/client/components/ui/primitives.css` (the primitive
library itself). 25 sheets are scanned. Classes starting with `ui-`
that appear in a scanned sheet (`ui-table`, `ui-btn`, `ui-input`,
`ui-modal-body`, …) are primitive-library collisions, not bespoke:
the gate skips them (one, `ui-modal-body`, is grandfathered S-U7
from the layout-only era — see Borderline calls — the other four
are not listed).

Target-based: only the **last simple selector** of each comma part is
the rule's subject. `.a .b { display: flex }` freezes `.b`, not `.a`;
`.a, .b { display: flex }` freezes both. Rules defined **only** inside
`@media` blocks are NOT scanned: the regex only matches a rule whose
selector starts outside a brace block, so a media-only rule never
reaches the scanner (verified by a minimal repro — this doc used to
claim the opposite).

## Measurement (base: post-#3135 main `1dc4a859`; tightened S-U4 #4820)

- **2,611 grandfathered classes** across the 25 scanned sheets:
  1,162 layout + 1,449 non-layout. Largest sheets (by entry file):
  `styles.css` 1,237, `options/strategyDiscovery.css` 459,
  `options/flows/optionsFlows.css` 173, `workflowsHub.css` 105,
  `options/optionsResearch.css` 95, `scheduledOptions.css` 72.
  123 classes are defined in more than one file.
- **S-U4 shrink.** The migration commit of #4820 deleted 53 classes
  (23 layout: the 20 `workflowRuns.css` entries + `social-btn`,
  `mini-social-btn`, `social-buttons`; 30 non-layout: the other 17
  `workflow-runs-*` classes + `did-modal-card` + `share-toggle-btn` +
  the 11 network classes `x-twitter`, `linkedin`, `reddit`,
  `facebook`, `whatsapp`, `telegram`, `threads`, `bluesky`,
  `hackernews`, `pinterest`, `discord`). The pre-tightening
  baseline was 1,185 layout classes and 2,668 total classes scanned;
  the tightened list holds 2,611 (the 4 scanned `ui-*` collisions
  `ui-btn`, `ui-checkbox-label`, `ui-input`, `ui-table` are not
  grandfathered — the gate skips `ui-*`).
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
  set; extending it is a future slice, not this one. (Moot since the
  S-U4 tightening: the freeze now covers every class, not a property
  subset.)
- **Template states (44 routes):** 1 `template` (risk-analysis), 23
  `shell`, 17 `hub`, 2 `chat-inline` (audit, nlq), 1 `exception`
  (chat). Only `src/client/RiskAnalysisPanel.tsx` renders
  `<PageTemplate` — verified, still the only one. 37 files render
  `<PageShell`; the hub wraps the 17 trading routes.

## Wave assignment

Each grandfathered class carries the slice that burns it down:

| Wave | Rule | Count |
|---|---|---|
| wave-1 (#3138–#3140) | `order-*`, `autopilot-*`, `executive-kpi-*` prefixes (any file), or defined in `optionsResearch.css` (either copy, #3139) | 126 |
| S-U4 | `workflowRuns.css` | 0 |
| S-U5 | `dataProvidersPanel.css`, `serviceTokensPanel.css`, `apiKeysPanel.css`, `loggedInUsersPanel.css`, `roleGrantsPanel.css`, `agenticWalletPanel.css`, `accountPanels.css`, `agentsPanel.css`, `docsAndReports.css`, `iaaaAdminPanel.css` | 205 |
| S-U6 | `reports.css`, `scannerPanel.css`, `portfolioRiskPanel.css`, `stockCopilotPanel.css` | 158 |
| S-U7 | `styles.css` (shared sheet), `options/strategyDiscovery.css`, `workflowsHub.css` | 1,777 |
| S-U8 | `options/flows/optionsFlows.css`, `scheduledOptions.css`, `chat/optionsCard.css`, `researchReports.css` | 277 |
| S-U9 | `options/riskAnalysis.css` | 68 |

Multi-file classes (123) take the **earliest** wave among their
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

Issue #4575 moved two of those surfaces and migrated one more: `audit`
and `nlq` are no longer inline `Chat.tsx` entries — they are the two
views of the new `audit-vault` page (`src/client/AuditVaultPage.tsx`),
which renders `PageTemplate` and is registered in the interior bucket
(5 PageSections, 27 bespoke class tokens, #3695 burn-down); the two
inline entries left the register with the move. `workflow-catalog`
migrated to `PageTemplate` in the same slice (its register state flipped
`shell` → `template`) when its sections became sub-tabs, so it joins the
conforming template routes rather than the S-U4 migration list.

## Borderline calls

- **Component-internal flex rows are frozen.** The definition is
  mechanical (any class rule): a button row inside a card
  (`.card-actions { display: flex }`) is a bespoke class and is
  grandfathered like any other. The page-vs-component distinction
  does not exempt a class; it only affects which slice burns it.
- **`ui-modal-body` (styles.css) is a namespace collision, not a
  primitive.** It shares the `ui-` prefix but is defined only in
  `styles.css` (`:10275`, `.stock-search-modal-dialog .ui-modal-body`)
  — `primitives.css` does not define it. Grandfathered S-U7. If a
  `ui-modal-body` primitive ever lands, this rule must be removed
  first.
- **`display: block` / `contents`, `position: sticky` / `relative`,
  and `gap` / `align-*` / `justify-*` alone are NOT freeze triggers —
  under the ORIGINAL layout-only definition only.** Since the S-U4
  tightening every class rule freezes regardless of its properties,
  so a rule with only `gap: 8px` is frozen like any other. The
  property list above is history, not the gate.
- **Duplicate definitions stay frozen in every file.** 123 classes
  are defined in more than one file (e.g. both `optionsResearch.css`
  copies); all definitions must go before the entry can be removed.
- **RiskAnalysisPanel's own sheet is frozen but unloaded.** The
  panel imports no CSS and has zero `className` occurrences, yet
  `options/riskAnalysis.css` still carries 68 classes.
  They are grandfathered S-U9 (the panel's slice) and die when the
  sheet is deleted, not before.

## Burn-down procedure

- **Delete a class:** remove the rule from its stylesheet(s) **and**
  its entry from `tests/ux_layout_freeze_3136.json` in the same PR.
  Removing the entry alone fails (the class is still scanned);
  removing the class alone fails (stale entry).
- **Add a class:** any bespoke class outside the list fails CI. Build
  from `src/client/components/ui/` primitives instead; if a new
  bespoke class is genuinely needed, the freeze definition itself
  must change in a dedicated PR — never silently extend the list.
- **Flip a route to template:** render `<PageTemplate` in the panel
  file, change its register entry to `state: "template"` (drop the
  wave), and extend `CONFORMING_TEMPLATE_ROUTES` in
  `tests/template_conformance_3136.test.ts` in the same PR.
- **Reassign a wave:** edit the entry's `wave` (freeze JSON) or the
  register entry (template register) with the reason in the PR body.
