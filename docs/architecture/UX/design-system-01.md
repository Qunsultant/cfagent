# UX Design System & Page Patterns

> **Consolidated successor:** this document's subject is consolidated
> into [`consolidated-design-system.md`](./consolidated-design-system.md)
> (DRAFT, placed 2026-11-04 per issue #3096). This file stays in place
> per the no-deletion gate; the consolidated doc is the successor for
> new work, while `docs/agents/ux-architecture.md` remains the live
> contract until the consolidated doc's §5 owner decisions land.

Status: accepted (2026-10-26). Deciders: owner, CPO-dhmp.
Issues: #1804 (epic), #1808 (S1: route table + PageShell foundation).
Governs with: ADR-0004 (token compliance mandatory, no exemptions),
`docs/agents/ux-architecture.md` §20 (definition of done).

## 1. The design system: what pages are built WITH

**Primitives** (`src/client/components/ui/`, token styles in
`primitives.css`, barrel in `index.ts`). Build ONLY from these — no raw
HTML controls in new components, no hand-rolled cards/badges/modals:

Button, Card, Badge, EmptyState, Notice, Spinner, Table, Tabs,
TextInput, Select, PillGroup, SegmentedControl, Field/FieldShell,
Skeleton, Checkbox, Modal, PageShell, PageSection.

**Tokens.** Semantic color tokens in `tokens.css`, mirrored into
`src/client/designTokens.ts` by `npm run tokens:gen` (regenerate whenever
tokens change). Spacing in `primitives.css` follows its rem convention;
density tokens arrive with E4 stage 2 — until then, no new spacing
scale is invented per page.

**Gates (all pinned by tests, all mandatory, no exemptions per ADR-0004):**

- Freeze test (`tests/ux_primitive_usage_freeze_1580.test.ts`): counts
  raw `button, input, select, textarea, table` JSX tags outside `ui/`
  against the allowlist; unlisted files must be zero.
- Token ratchet (`tests/ux_token_coverage_ratchet.test.ts`): no raw
  color literals outside token sources; new surfaces must import a
  `ui/` primitive (primitives themselves are exempt by definition);
  one-off stylesheets carry exact line-count pins (bump in-PR when a
  file legitimately grows).
- Contrast gate (`tests/ux_token_contrast_drift.test.ts`): 25 semantic
  pairs × 3 themes at WCAG 2.2 AA 4.5:1.
- Route-table completeness (`tests/route_table.test.ts`) and nav
  derivation (`tests/nav_derivation.test.ts`): see §3.
- Shell conformance (`tests/shell_conformance_1804.json` +
  `tests/shell_conformance.test.ts`): the list of pages migrated
  onto the shell, complete at 25 of 26 after S4. The only unlisted
  page is `chat`, deferred by product decision (ADR-0021), not
  grandfathered work.

## 2. The design patterns: what pages are built AS

**Shell / outlet.** Every left-nav page renders inside `PageShell`:
title (h1) + scope note + sections, with loading (Spinner), empty
(EmptyState), and error (Notice) states carried by primitives. No
hand-rolled page chrome, no custom wrapper class as page root. Pages
are sections, not monoliths: each `PageSection` owns its data and
surface (usually Cards). This is what kills the h3-plus-inline-margin
section pattern and the raw `<div>Loading…</div>` state pattern.

**Route-driven navigation.** The URL is the source of truth for
navigation (see §3). Deep-linking, back/forward, and reload-safe place
work for every page at page level (`?tab=`), not just one hub.
Inner-view deep-linking (the generic `view` param) is S2, still open.

**Retained views.** Some views stay mounted-hidden so in-flight and
finished work survives tab switches. The exemplar is the trading view
(`ETradeTradingHub`, kept mounted hidden in Chat). Retention is a
property of the route, enforced by the outlet once the content switch
is derived; S4 migrated pages onto the shell WITHOUT deriving that
switch, so it is still declared in this doc and implemented in Chat's
existing hidden div (trading view) — the derived switch + retained-mounted
outlet remain open work.

**Tabbed browsing (per #1379).** Multi-view pages use tabs that are
URL-synced, keep visited tabs mounted-hidden so state survives
switching, and expose ARIA tablist/tabpanel with roving tabindex.
#1379 built this inside ScreenersHub with a bespoke tablist; S2
reconciles it into the `Tabs` primitive (URL-sync + retention) and
migrates the hub onto it, leaving exactly one tab mechanism.
Standing direction (2026-10-27): tabbed browsing rolls out
system-wide on this pattern, beginning with the screener hub as the
exemplar.

**Composition over monoliths.** A page composes components that own
their data; it never re-fetches and re-renders. The positive exemplar
is ApprovalsPanel (composes TradingApprovalsQueue + PendingReviewQueue,
#1799). The negative exemplar is SocialPostingPanel (one component
fetching goal + approvals + posts + token health + ticks and rendering
six sections inline) — S3 split it into sections on the new shell (merged).

**Primitive states.** Loading, empty, and error states always come
from Spinner/Skeleton/EmptyState/Notice. A raw div state is a defect,
not a style choice.

**Section treatment.** Section headers are `PageSection` titles, never
hand-rolled h3s with inline margins. Layout comes from primitives and
tokens, never inline `style` layout.

## 3. The route-table architecture (S1, #1808)

One table, `src/client/routes.ts`, is the single source of truth. Each
of the 26 historical tab ids is an entry: the 20 entries that render in
the nav carry `navEntry` (label, shortLabel, `navOrder` reproducing the
historical sidebar/top-strip order, defaultVisible, badge); the 6
legacy/alias ids (trading, orders, scanner, reports, schedules, options)
carry no `navEntry` and instead name their `navGroup` — the nav entry
highlighted when they are active. Every entry carries `crumb` (the
breadcrumb label, which differs from the nav label on 13 entries) and
`description`. The table stays sorted alphabetically by id so
concurrent additions land at different positions instead of one
prepend anchor (the CHANGELOG lesson).

Derived from the table, never hand-maintained in parallel:

- `NAVIGATION_ITEMS`, `NavTabId`, `DEFAULT_VISIBLE_NAV_TABS`, and
  `isTabActive` (NavigationMenu.tsx; icons resolve through a
  key-to-component map, so the table stays pure data).
- The breadcrumb (Chat.tsx: `getCrumb(tab)` replaces the 26-branch
  ternary).
- Tab state (Chat.tsx: initialized from the URL, following the router
  on back/forward and on every navigation).

The router (`src/client/router.ts`) carries the tab in `?tab=<id>` —
query params, so no Worker fallback is needed for deep links or
reloads. Navigation pushes state and notifies subscribers; re-clicking
the active item pushes nothing (no duplicate history entries); unknown
ids fall back to autopilot. Every other query param passes through
untouched, notably the screening hub's `?screenerTab=`.

Deliberately NOT in S1, with the slice that owns each:

- Component map (the content switch is still Chat's inline blocks plus
  panels — Chat owns inline tab sections plus tab-triggered data
  fetching, so extraction is per-page S3–S4 work; a half-derived switch
  would be two mechanisms).
- Retained-mounted outlet (lands with the derived switch).
- Generic inner-tab (`view`) param (S2, with the Tabs extension).
- Path-based routing (a future option if a Worker fallback lands;
  query routing was chosen because it needs no server change).

## 4. Migration path

S1 (this doc's build): table + router + PageShell + tests. S3: social
was the first page proven on the new shell (tabs + PageShell + shared
approval cards). S4 (merged as S4-A/B/C1/C2/D): one pass per remaining
nav page; each migrated page joined `tests/shell_conformance_1804.json`,
ending at 25 of 26. The epic closes with `chat` deferred (ADR-0021),
not with every nav entry listed — the deferred page is a recorded
product decision, not remaining migration work.

## 5. Rejected alternatives

- **Framework migration** (e.g. Next.js): fights the Worker plus
  Durable Objects deployment and buys little — the problems here are
  patterns, not tooling.
- **Micro-frontends**: for a single-team SPA they multiply the
  consistency problem this program exists to solve.
- **Keeping five registration places plus a test**: the test pins drift
  after the fact; the table removes the drift at the source.
