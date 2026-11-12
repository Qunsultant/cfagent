# NextGenTP Design System — Consolidated Specification (DRAFT)

> **Status: DRAFT — placed in `docs/architecture/UX/consolidated-design-system.md`
> per owner approval 2026-11-04 (issue #3096).** The 7 owner decisions
> in §5 are still pending, and no code has changed under this document.
> Placement is not approval of its contents: it does not replace
> anything on its own, and `docs/agents/ux-architecture.md` remains the
> live contract until the §5 decisions land.
>
> **What this document is.** One holistic replacement for the
> scattered UX documentation: the page template (§1), the design
> system and its rules (§2), and the simplified theme system under
> the rule of three (§3). §4 maps every section to the docs it
> consolidates and lists the contradictions found between them
> without silently resolving them.
>
> **Sources of truth at draft time.** Repo `Qunsultant/cfagent` at
> main `00778ba` (2026-11-03). Code facts below were read from that
> tree, not from the older docs, wherever the two disagree — the
> disagreements are recorded in §4. The route table is described as
> it exists at `00778ba` (`src/client/routes.ts`); issue #2977
> (implementation PR #2978, in flight at draft time) moves it to a
> data file, which changes where the route step is edited
> and nothing else in §1.

## 0. The governing rule: rule of three

**Owner directive, 2026-11-03 — a guideline, not a rule
(correction 2026-11-03: the draft originally stated this as
"a rule, not a suggestion"; the owner corrected it to a
guideline):**

> Themes are simplified. No more than **3 types of each UX element**
> as a guideline: 3 button types, 3 panel types, and so on for
> every element family.

**Anything that doesn't or cannot conform must be identified
as an exception with justification** (§3.6). A documented
exception is compliant with the guideline; an undocumented
deviation is not.

How to read it:

- A **type** is a distinct visual/behavioral variant of an element
  (a `Button` variant, a `Notice` tone, a `Modal` size, a `Card`
  treatment). A **scale** (spacing steps, font sizes, radii) is not a
  type, but scales are frozen: no scale grows, and no new scale is
  invented per page.
- **3 is a ceiling, not a target.** A family with 2 types is fine.
  A family with 3 types is at the guideline limit — a fourth is
  a documented exception (§3.6), not an addition by default.
- The guideline applies to **new work immediately** and to existing
  families via the collapse list in §3.4. A collapse that changes
  rendered output is a behavior change: it updates its pins in the
  same PR (the pin rule, §2.7). A collapse the owner rejects does
  not leave the family in violation — it becomes an exception
  entry in §3.6 with its justification recorded.
- **Nothing in this rule weakens ADR-0004.** A merge that leaves a
  surface without a genuine primitive use is still non-compliant;
  the surface is reworked, not exempted (§2.6).

---

## 1. Page template — the canonical shape of a page

Every page in the app is the same shape. A new page provides the
items in §1.7 and nothing else; everything else is derived.

### 1.1 Route — the page's identity

One entry in the route table (`src/client/routes.ts` at `00778ba`;
`nav-config.json` after #2977). Fields:

| Field | Meaning |
|---|---|
| `id` | The tab id carried in the URL (`?tab=<id>`). Sorted alphabetically in the table so concurrent additions land at different positions. |
| `navEntry` (optional) | Present only for entries that render in the nav: `label`, `shortLabel`, `navOrder` (unique, 0-based, reproduces the historical sidebar order), `defaultVisible`, optional `badge` + `badgeType`. Absent for legacy/alias ids and host routes. |
| `navGroup` | The nav entry highlighted when this tab is active. Legacy ids name their group (e.g. `trading` → `autopilot`, hub children → `screeners`); the four hub children highlight `screeners`. |
| `crumb` | Breadcrumb label; differs from the nav label on 13 entries. |
| `category` | One of `Execution`, `Intelligence`, `Playbooks`, `Platform`, `Billing`, `Marketing`. Determines the left-nav section. |
| `icon` | A `NavIcons` key; icons resolve through a key-to-component map so the table stays pure data. |
| `description` | One-line scope text for the page. |
| `retain` | `true` → the page renders in the always-mounted trading hub (§1.4). Derived set `TRADING_TABS` (18 ids at `00778ba`). |
| `shellRetain` | `true` → the page renders from mounted-hidden shell content (§1.4). Deliberately not `retain`: it must not route to the trading hub. |

At `00778ba`: **41 route ids, 31 nav entries** (`navOrder` 0–30).

### 1.2 Navigation — derived, never hand-maintained

`src/client/navConfig.ts` builds the left nav from the route table:

- **Sections** from section metadata, in order: Trading &
  Execution, Intelligence & Copilot, Workflows, Marketing,
  Orders/Billings/Payments, Platform — plus the menu-only Sandbox
  and Planned sections.
- **Items** are the routes with `navEntry`, sorted by `navOrder`
  within their category section. Routes whose primary home is a
  sub-menu (the hosted set: options-flows, research, docs,
  workflows, endpoints, platform-admin, and the six Billing pages)
  do not repeat as top-level items.
- **Sub-menus** from the sub-menu configs (stock-hub,
  options-screener, assets-hub, workflow-runs, agents,
  platform-admin, sandbox, orders, billing, payments, planned).
  Special assemblies: the goal-screen item in Intelligence,
  platform-admin + schedules in Platform, and the three Billing
  parents (Orders/Billing/Payments — parents that share an id with
  their page toggle on click and navigate, the workflow-runs
  precedent; menu-only parents toggle only).
- **Active state** (`LeftNavBar`): an item is active when it is the
  current tab, when the current tab's `navGroup` is the item, or
  when one of its sub-items is active. Sub-menus auto-expand when a
  sub-item is active. The active row is `sidebar-nav-item active`.
- **Deep links** (`src/client/deepLinks.ts`): every nav node maps
  to a shareable URL. Keyed override → bare-id override →
  `platform-admin:<section>` rule → default `?tab=<resolved id>`.
  The surface-tab catalog (14 surfaces: the three hubs, platform
  admin, payments, social, ads, referrals, revenue, workflows,
  checkout, iaaa-admin, reports-panel, risk-analysis) maps surfaces
  to `?tab=<page>&<param>=<value>`.

### 1.3 URL contract — the URL is the source of truth

`src/client/router.ts` + `useUrlSyncedTabs`:

- Page: `?tab=<id>`. Hub inner view: `?tab=<hub>&view=<tab>`.
  Query params, so no Worker fallback is needed for deep links or
  reloads.
- Tab read order: query param → query aliases (legacy params such
  as `screenerTab`, read-only) → bare hash → hash param → hash
  aliases → `initialTab` if valid → `defaultTab`. Only the
  canonical param is ever written; aliases stay read-only.
- Navigation pushes state and notifies subscribers; re-clicking
  the active item pushes nothing (no duplicate history entries).
  Unknown ids fall back to `autopilot`. Back/forward follows the
  router. Every other query param passes through untouched.
- Hub tabs are URL-synced (`useUrlSyncedTabs`, subscribed via
  `subscribeToRouteChanges` since the #2923 fix) and keep visited
  tabs mounted-hidden so state survives switching.

### 1.4 Outlet — where the page renders

`src/client/Chat.tsx` renders exactly one of three outlets:

1. **`TAB_CONTENT`** — plain pages. A map from tab id to content.
   A tab with no entry and no retained host renders a warning
   Notice ("Missing tab content… This is a wiring gap, not an
   empty tab") — never a silent blank.
2. **`SHELL_CONTENT`** — shell-retained pages (`shellRetain`).
   Always mounted, `hidden` unless active, so in-flight work and
   state survive tab switches.
3. **The trading hub** (`ETradeTradingHub`, `trading-view` div) —
   retained pages (`retain` / `TRADING_TABS`). Kept mounted hidden
   for the same reason. Its inner sub-tab mapping lives in
   `chat/types.ts` (`mapTabToTradingSubTab`); its `tabLabels`
   record must cover every union member (enforced by `tsc`).

Feature gating sits above the outlet: `TAB_TO_FEATURE_MAP`
(`src/client/featureFlags.tsx`) maps tab ids to flags; an unmapped
tab is core (visible). Gating hides the page; it never changes
what the page is.

### 1.5 Chrome — PageShell, always

Every left-nav page renders inside `PageShell`
(`src/client/components/ui/PageShell.tsx`):

- **Header:** `title` (the page's `h1`) + optional `scopeNote`
  (one line: what this page covers).
- **Sections:** `PageSection` children, each with `title` (the
  section's `h2`) + optional `description`. Sections own their
  data and surface (usually `Card`s). Pages are sections, not
  monoliths; a page never re-fetches and re-renders what a
  component owns.
- **States, carried by primitives, in precedence order:**
  `loading` (Spinner; initial load only — never wire
  refresh-loading to it, or the page blanks on refresh) →
  `error` (danger Notice) → `empty` (EmptyState) → children.
- **Forbidden chrome:** no hand-rolled page header, no custom
  wrapper class as page root, no hand-rolled `h3` + inline-margin
  section headers, no raw `<div>Loading…</div>` state.

The one recorded exception is `chat` itself, deferred by product
decision (ADR-0021) — deferred, not grandfathered. Hub pages
(StockHub, OptionsHub, ScreenersHub) render through the trading
hub outlet, not PageShell; that is architecture (§1.4), not an
exemption from it.

### 1.6 Composition — sections, panels, components

- A page composes components that own their data. Positive
  exemplar: ApprovalsPanel (composes TradingApprovalsQueue +
  PendingReviewQueue). Negative exemplar (fixed in S3):
  SocialPostingPanel fetching five domains and rendering six
  sections inline.
- Panels are `Card` surfaces inside `PageSection`s. A panel that
  renders no controls itself still builds its own chrome from
  primitives (ADR-0004: the ApprovalsPanel precedent is a `Card`
  header block, not a wrapper around already-carded children).
- Multi-view pages use tabs: URL-synced, visited tabs
  mounted-hidden, ARIA tablist/tabpanel with roving tabindex.
  The `Tabs` primitive is the one tab mechanism for new work;
  ScreenersHub's bespoke tablist is the known leftover (§4, C3).
- Panels separate content from chrome: a panel's content renders
  bare inside another page's tab, and the route owns the
  `PageShell`. A panel that can only render inside its own shell
  is not composable (issue #3125: `RiskAnalysisContent` embeds in
  the order page's Risk tab while `RiskAnalysisPanel` keeps the
  shell for the standalone route).

### 1.6a Modularity and composability — the order-workspace pattern

The stock and options order pages are the reference composition: they
are beautiful because of structure, not decoration. Every page that
carries a workflow must be at least as composed as the order page, and
the composition must work without editing the component being
composed. The order-workspace pattern has six elements:

1. **Form card** — the whole input flow in one bordered, padded card
   with a distributed header row (bold title left, muted subtitle
   right) and labeled fields at consistent density.
2. **Summary card** — a sunken surface with the headline numbers as
   label/value rows (the calc-card equivalent): the answer before the
   detail. A page of bare tables with no summary surface is not
   acceptable — that was the S1 risk page's failure.
3. **Responsive grid** — the `Grid` primitive's auto-fit row (form and
   summary side by side on wide screens, one column on narrow ones).
   Fixed two-column CSS that never collapses is not acceptable.
4. **A card per content block** — every section renders a `Card`
   surface with its own header; content never sits bare in a section.
5. **Context strip** — the live context (symbol, spot, strategy) as a
   sunken strip or summary rows, so the page never shows numbers
   without saying what they belong to.
6. **Alerts as `Notice`s in flow** — warnings and disclosures inline
   where they apply, never as a second-class footnote.

**Composability rule.** Chrome is host-applied, never component-owned
beyond declaring it. A panel renders its `PageShell` (title +
scopeNote) exactly once, and the host decides how that shell renders
via `PageChromeContext` (`PageShell.tsx`):

- `page` (default): the standalone route — full shell, h1 + scope note.
- `tab`: the panel is a tab on another page — the tab's label is the
  title, so the shell renders content only, no second header.
- `nested`: the panel sits inside another panel — it becomes a `Card`
  surface with its title as the card heading, never a second h1.

Three moves must work with zero changes to the composed component:

- a pane nested inside other panels (wrap it in a `nested` provider);
- a page showing up as a tab on another page (wrap it in a `tab`
  provider inside a `TabPanel`);
- a tab promoted to a standalone page, or a page demoted to a tab
  (move the same component between hosts; the route owns the shell).

Only `PageShell` reads the context. A panel that branches on its host
(`if (isTab) …`), strips its own shell for embedding, or ships a
separate bare variant is not composable — that was the first #3125
approach (a split `RiskAnalysisContent`), replaced by host-applied
chrome. Data travels by props (a tab may seed a panel, e.g. the live
ticket into Risk); structure travels by context. Props customize what
a panel shows, never how it is composed.
- Capability tabs in the top bar (`CapabilityNavBar`, ids
  `cap-tab-<id>`) are a separate mechanism from left-nav pages:
  they switch capability views within the chat surface.

### 1.6b Template slots — the seven slots (#3131)

Every page is the same seven slots in the same order. `PageTemplate`
(`src/client/components/ui/PageTemplate.tsx`) is the component that
renders them: slots as props over the `PageShell` chrome (title +
scope note + loading/error/empty states, §1.5), with the chrome
hosts (page/tab/nested, §1.6a) preserved — `PageTemplate` renders
`PageShell`, which reads `PageChromeContext`, so the same template
renders as a standalone route, as a tab, and nested, with zero
changes to itself.

| # | Slot | Holds | Filled by |
|---|---|---|---|
| 1 | Header | Page title (h1) + scope note | `PageShell` (§1.5) |
| 2 | Context strip | Live context: symbol, spot, strategy | `ContextStrip` (#3132); until then, the page's own primitive-built strip |
| 3 | KPI ribbon | Headline numbers as label/value rows | `KpiRibbon` (#3132); until then, `SummaryCard` content in a `Card` |
| 4 | Workspace | The page's sections — the work itself | `children` (the workspace slot); `WorkspaceGrid` (#3134) for the grid |
| 5 | Action bar | The closing actions for the page, after the workspace | `ActionBar` (#3134) — primary right, secondary left |
| 6 | Queue rail | The closing section below the workspace: queue, feed, approvals | `QueueFeed` (#3134) — a `Card` with `CardHeader` + items, `EmptyState` when empty |
| 7 | States | Loading / error / empty, in precedence order | `PageShell` (§1.5) — states win over every slot |

Composition rules for slots:

- Pages compose slots, never layout CSS. A page that needs a new
  arrangement gets a new slot or a new `WorkspaceGrid` variant, not
  a bespoke wrapper class or inline style.
- The rule of three (§0) applies at every level: ≤3 button types,
  ≤3 card treatments, ≤3 header treatments — and ≤3 slot variants
  per slot. A fourth variant is an exceptions-register entry (§3.6),
  not a quiet addition.
- Slot spacing is the template's, not the page's: slots render in a
  `Stack` at the order-workspace gap. A slot never sets its own
  outer margin.
- A slot that has nothing to show renders nothing — no empty card,
  no placeholder strip. The workspace alone is a complete page. (A
  queue with no rows is the exception: `QueueFeed` shows its
  `EmptyState` — an empty queue is information, not an absent slot.)

Template organisms III (#3134): `WorkspaceGrid`, `ActionBar`,
`QueueFeed` fill slots 4–6. Breakpoints (Material 3
window-size-class idea, web values): compact <900px, medium
900–1440px, expanded >1440px. `WorkspaceGrid` variants are
workspace (auto-fit grid), list-detail (the order ticket's 1.4fr/1fr,
collapsing to one column below 900px), and feed (single column) —
exactly three, no fourth. `ActionBar` closes the page's work after
the workspace (the earlier "answer-before-detail" wording was
wrong); `QueueFeed` is the closing section below the workspace,
not a side rail — a true side rail would need a two-column template
variant, which is a new slot arrangement, not an organism.

First consumer: the risk page (`RiskAnalysisPanel`), already
template-shaped, renders through `PageTemplate` with no visual
change. Every further migration (#3138–#3140 onward) is the same
move: same content, slots named, nothing else changed.

### 1.7 New-page checklist — what a page must provide

1. Route entry: `id`, `navGroup`, `crumb`, `category`, `icon`,
   `description`, plus `navEntry` iff it renders in the nav, plus
   `retain` or `shellRetain` iff it must survive tab switches.
2. Content: a `TAB_CONTENT` entry, a `SHELL_CONTENT` entry, or a
   trading-hub sub-tab branch with a `tabLabels` entry — exactly
   one outlet, never two.
3. Chrome: `PageTemplate` (`PageShell` chrome: `title` (+ `scopeNote`)
   + states) with `PageSection`s in the workspace slot; loading/empty/error via the primitive states.
4. Composition: primitives only (§2.3), token-only styling (§2.2),
   no new spacing scale, no raw controls, no hand-rolled
   card/badge/modal/toast.
5. URL: `?tab=` works on reload and back/forward; hub inner views
   use `view` and stay in sync; a deep-link entry if the page's
   link differs from the default rule.
6. Composition hosts: the panel renders correctly as a standalone
   route, as a tab (`PageChromeContext` = `tab`), and nested
   (`PageChromeContext` = `nested`) — pin tests cover all three
   hosts for the SAME component, with no per-host edits (§1.6a).
7. States: settled-but-empty renders `EmptyState`, never a
   "Loading…" empty state; async buttons use the Button `loading`
   prop, never a label swap; a completed action that changes
   nothing visible gets a transient Toast (§2.5).
8. Access: keyboard flow, visible focus, programmatic labels,
   live-region announcements for milestones only (§2.4).
8. Pins: route-table, nav-derivation, shell-conformance, and
   wiring-gate pins updated in the same PR (pin rule, §2.7).
   A page that is not wired is a failing test, not a TODO.

---

## 2. Design system and its rules

### 2.1 What the system is

Three layers, in dependency order:

1. **Tokens** — `src/client/tokens.css` is the source. `:root`
   holds palette-independent foundations (brand, font, space,
   radius, font sizes); per-theme maps (`:root`/`[data-theme=
   "dark"]`, `[data-theme="light"]`, `[data-theme=
   "high-contrast"]`) supply every semantic `--color-*` role.
   `src/client/designTokens.ts` mirrors the semantic tokens
   (generated by `npm run tokens:gen`, never edited by hand) and
   carries the typed role lists, the density API, and the brand
   re-export. `src/client/branding.ts` (`BRAND`, issue #1297) is
   the single source for the system name, tagline, badge, copilot
   name, search name, storage prefix, and the multi-agent
   ecosystem — every surface derives branding from it, never from
   a hardcoded string.
2. **Primitives** — `src/client/components/ui/` (styles in
   `primitives.css`, barrel in `index.ts`). The only components a
   page may build from.
3. **Composition** — pages, hubs, and panels assembled from
   primitives (§1.6). No other layer exists: no second component
   framework, no per-page component library.

The landing page is vanilla (no React) and renders its own
theme-aware markup from the same generated tokens
(`src/client/landing.ts` imports `generatedThemeTokens`). It is
the one sanctioned second renderer, and its theme toggle is a
known duplication (§4, C10).

### 2.2 Tokens — semantic names, never raw values

- **Color roles** (typed in `designTokens.ts`): `surface`,
  `surface-foreground`, `surface-raised`,
  `surface-raised-foreground`, `surface-sunken`,
  `surface-sunken-foreground`, `card`, `card-foreground`,
  `muted`, `muted-foreground`, `input`, `input-foreground`,
  `input-border`, `text-primary`, `text-secondary`, `text-muted`,
  `text-dim`, `text-inverse`, `border-subtle`, `border-medium`,
  `border-focus`, `accent`, `accent-contrast`, `primary`,
  `primary-foreground`, `danger`, `danger-foreground`, `success`,
  `success-foreground`, `warning`, `warning-foreground`, `info`,
  `info-foreground` (36 roles). Components reference roles via
  `var(--color-<role>)`, never a hex literal.
- **Surfaces** pair with foregrounds: every surface role has a
  foreground role; a surface never borrows another surface's text.
- **Status** uses semantic names (`status.running`,
  `status.blocked`, `status.needsApproval`, `status.failed`,
  `status.completed` in prose; the tone vocabulary in §3 for
  components). Color is never the only indicator: status always
  carries text, an icon, or both.
- **Scales (frozen, §0):** spacing 14 steps (`--space-0` …
  `--space-16`), radii 7 steps (`--radius-xs` … `--radius-full`),
  font sizes 9 steps (caption, body-sm, body, body-lg, title-sm,
  title, title-lg, display, micro). No page invents a spacing
  scale; density arrives as a preference, not a per-page scale.
- **Density** is a user preference with two modes, `compact` /
  `comfortable` (key `nextgentp_density`, `data-density`
  attribute, cross-tab sync). Density changes spacing; it never
  changes which components a page uses.
- **Motion:** `prefers-reduced-motion` is respected in both
  `tokens.css` and `primitives.css`; animation never carries
  execution state (§2.4).
- **Mirror rule:** `npm run tokens:gen -- --check` must report
  the `designTokens.ts` mirror in sync; `node
  scripts/token-coverage.mjs` must report TOTAL raw = 0 for
  client changes. A PR that trips either is sent back.

### 2.3 Primitives — the complete inventory

`src/client/components/ui/` (23 components + helpers). A new
recurring element becomes a primitive (in its own PR, with
tests, joining the reviewed inventory pin) — never a page-local
copy.

| Primitive | Role | Variants today (see §3 for the rule-of-three audit) |
|---|---|---|
| `Button` | Action button; `loading` prop with `aria-busy` | 7 variants × 2 tones × 3 sizes |
| `Card` | Surface container (flat/elevated/highlight; padding scale) | 3 treatments × 4 paddings |
| `Badge` | Status/label pill, optional status dot | 8 tones × 3 sizes |
| `Notice` | Inline banner/alert for persistent state | 6 tones × 2 variants (box/strip) |
| `Toast` + `useToast` | The one global transient-feedback channel | 4 tones |
| `Modal` | The one dialog system (portal, Escape, focus trap + restore, scroll lock, backdrop close) | 5 sizes (incl. `none`) |
| `Drawer` | Side panel on the Modal behavior contract | — |
| `Menu` | WAI-ARIA menu button (roving keys, `aria-expanded`, danger tone) | — |
| `Popover` | Non-modal trigger-anchored dialog (no focus trap by design) | — |
| `Tabs` + `TabPanel` | ARIA tablist/tabpanel, roving tabindex, arrow/Home/End, automatic activation | 2 sizes |
| `SegmentedControl` | Single-selection radio group, badges, roving tabindex | 3 sizes |
| `PillGroup` | Selection pill group | 5 color variants × 2 sizes |
| `TextInput` / `Select` | Labeled form controls, hint/error wiring (`aria-invalid` + `aria-describedby`) via `FieldShell` | 2 sizes |
| `Field` / `FieldShell` | Shared label/hint/error shell for controls | — |
| `Checkbox` | Native boolean toggle; the `label` prop is the one way to label it | — |
| `FileInput` | File control on the token input family | — |
| `Table` | Semantic data table from a column config; `empty` slot (Spinner while loading, EmptyState once settled); sortable headers are real buttons with `aria-sort` | — |
| `Spinner` | Region loading indicator (`role="status"`) | 3 sizes |
| `Skeleton` | Content-shaped loading placeholder | 3 variants (text/block/circle) |
| `EmptyState` | Settled-but-empty block (optional `framed` panel) | — |
| `PageShell` + `PageSection` | Page chrome (§1.5) | — |
| `SkipLink` | Skip navigation link | — |
| Helpers | `anchorPosition`, `segmentedNavigation` | — |

### 2.4 Composition rules

- **Primitives only.** No raw HTML controls in new components,
  no hand-rolled cards, badges, modals, or toasts, no raw color
  literals outside token sources, no hardcoded density/spacing
  values, no inline `style` layout. Layout comes from primitives
  and tokens.
- **Server-confirmed state only.** Never optimistically display
  "sent", "paid", "traded", or "deployed". Distinguish requested
  actions from confirmed outcomes; reconcile from a snapshot
  after reconnect; protect mutations from stale versions.
- **Business errors, not technical errors.** Error states answer
  five questions: what happened, what completed, what remains
  uncertain, is retry safe, what can the user do next. When an
  external action times out, reconcile whether it already
  succeeded before offering retry. Preserve drafts, filters, and
  recoverable context.
- **Approvals are exact and version-bound.** Before a
  consequential action, show the exact action, resolved target,
  complete material content, cost/exposure, evidence,
  reversibility, and expiry. If the target, amount, content, or
  conditions change, a new approval is required. Disabling a
  button is not access control — the backend enforces it.
- **Evidence and uncertainty are inspectable.** Every
  consequential result supports source identity, timestamps,
  freshness, assumptions, missing information, conflicting
  evidence, and methodology. No unexplained model-generated
  confidence percentage: use `Verified against source` /
  `Calculated from supplied inputs` / `Estimated under stated
  assumptions` / `Unverified`.
- **Accessibility is acceptance, not enhancement.** Target WCAG
  2.2 AA across complete flows: semantic structure and
  programmatic labels, keyboard operation, visible focus never
  entirely obscured, text and non-text contrast, reflow and text
  resizing, accessible errors and status, alternatives to
  dragging, accessible authentication. Touch targets prefer
  44×44 CSS px where practical (the AA minimum is 24×24; 44×44
  is the AAA criterion — the spec states this explicitly so the
  two are not confused). Agent-specific: never announce streamed
  tokens; announce milestones via live regions; allow pausing
  auto-scroll; preserve focus during updates; never move focus
  merely because an agent produced a message; text/table
  alternatives for charts.
- **Privacy and memory are inspectable.** Users can see what is
  remembered, why, which tasks/tenants can use it, and how to
  correct or delete it. Task context, conversation history,
  explicit saved preference, verified domain record, and inferred
  preference are distinct; speculation is never silently promoted
  to a durable fact.

### 2.5 Feedback — Toast vs Notice (the one rule)

| | Toast (global) | Notice (inline) |
|---|---|---|
| **For** | Transient feedback: something the user did succeeded or failed and does not need to stay on screen | Persistent state: warnings, guarantees, page-level error/empty states that must remain visible |
| **Where** | One viewport, mounted once at the app root (`main.tsx`), bottom-right, same shape whatever panel acted | Inline, in the page/panel it belongs to |
| **Tones & timing** | success/info auto-dismiss 5s, warning 8s, danger persists until dismissed; every toast has a dismiss button; hover/focus pauses the timer; Escape dismisses the newest while focus is in the viewport; toasts never steal focus | Tones per §3; `danger`/`warning` announce via `role="alert"`, others via `role="status"` (`neutral` announces nothing) |
| **Rules** | No native `alert()`/`confirm()`; no per-panel toast one-offs; identical visible toasts dedupe; at most 4 visible, newest on top | A completed action that changes nothing visible gets a Toast, not silence and not a persistent Notice |

### 2.6 Compliance — ADR-0004: mandatory, no exemptions

Compliance with the token architecture is **all or none**
(ADR-0004, accepted 2026-10-26, owner + CPO-dhmp, issue #1705):

- Every surface, including composition-only surfaces, must
  satisfy the coverage ratchet by genuinely composing from
  primitives. A surface that renders no controls itself still
  needs its own chrome primitive-built (the ApprovalsPanel
  precedent: a `Card` header block).
- **No entry may be added to the exemptions of
  `tests/ui_primitives_1337.json`.** The registry stays empty
  (verified: `"exemptions": []` at draft time). A surface that
  cannot comply is reworked until it complies; its PR stays red
  until then.
- The exemption mechanism remains in the ratchet test code but
  its use is prohibited. Removing the mechanism is follow-up
  work, not part of the decision.
- Decorative primitive imports (importing without meaningful
  use, e.g. type-only) are rejected: they game the gate and are
  worse than an honest exemption.
- The same all-or-none logic extends to the rule of three: a
  family over the limit is collapsed, not exempted.

### 2.7 Gates and pins — how the rules are enforced

All pinned by tests; all mandatory; a change and the pins it
alters travel in the same PR, never in a follow-up (gitops §7,
the pin rule).

| Gate | What it enforces | Pin |
|---|---|---|
| Token coverage ratchet | Zero raw color literals outside token sources; every new JSX surface under `src/client` imports a `ui/` primitive | `tests/ux_token_coverage_ratchet.test.ts` (+ `ux_token_coverage_ratchet.json`) |
| Primitive usage freeze | Raw `button, input, select, textarea, table` JSX tags outside `ui/` counted against an allowlist; unlisted files must be zero; counts ratchet down, never up | `tests/ux_primitive_usage_freeze_1580.test.ts` (+ `ux_primitive_usage_allowlist_1580.json`) |
| Primitives inventory | A reviewed inventory of `ui/` source file → exported components; a new primitive joins in its own PR with tests | `tests/ui_primitives_inventory.test.ts` (+ `tests/ui_primitives_1337.json`, exemptions `[]`) |
| Contrast drift | Semantic color pairs at WCAG 2.2 AA 4.5:1 across all 3 themes | `tests/ux_token_contrast_drift.test.ts` (25 pairs × 3 themes = 75 checks) |
| Bespoke ceiling | Caps on hand-rolled client surface: braces ≤ 3920, classes ≤ 2686, inline styles ≤ 807, raw labels ≤ 0 (values as written in the test at draft time; the #2177 close bumped braces/classes) | `tests/ux_bespoke_ceiling_2177.test.ts` |
| Token parity | The `designTokens.ts` mirror is in sync with `tokens.css` | `npm run tokens:gen -- --check` |
| Token coverage | TOTAL raw = 0 for client changes | `node scripts/token-coverage.mjs` |
| Route table + nav derivation | Route completeness and nav derivation from the table | `tests/route_table.test.ts`, `tests/nav_derivation.test.ts` |
| Shell conformance | Pages migrated onto the shell (list frozen at S4 — see §4, C2) | `tests/shell_conformance_1804.json` + `tests/shell_conformance.test.ts` |
| Wiring gate | Every `src/client` component file is imported somewhere or listed in `KNOWN_ORPHANS` with a reason; listed orphans are asserted not imported | `tests/tab_content_wiring_gates.test.ts` |
| Loading/empty pins | No EmptyState title contains "Loading" (scan tracks `{}` depth, so JSX-valued props cannot hide a title); no Button child ternary swaps to an ellipsis label | `tests/ux_no_loading_empty_2283.test.ts`, `tests/ux_button_loading_2283.test.ts` |
| Density ratchet | Density tokens respected; no per-page spacing scale | `tests/ux_density_ratchet_1580.test.ts` |
| Branding tokens | Brand strings derive from `branding.ts`, not literals | `tests/ux_branding_tokens.test.ts` |
| Modal token architecture | Dialogs use the Modal primitive and token classes | `tests/modal_token_architecture.test.ts` |
| Composable primitives | Primitives compose and meet their contracts | `tests/composable_ui_primitives.test.ts` |

Test conventions that are part of the system: vitest + jsdom;
JSX test files are `.test.tsx`; portaled dialogs/toasts are
queried on `document.body` (portals render outside the test
container); source-scan pins strip comments and strings; the
shared jsdom URL is reset between tests; components using
`useToast` throw without a `ToastProvider`; `Element.prototype.
scrollIntoView` is stubbed.

### 2.8 Definition of done (ux-architecture §20)

A feature is complete only when its primary and failure journeys
work; server state and UI state agree; permissions are enforced;
approvals show exact consequences; evidence and uncertainty are
inspectable; keyboard and relevant assistive-technology flows are
tested; reconnection and cancellation behavior is demonstrated;
no placeholder activity is represented as real; telemetry and
privacy behavior is documented; tests and known limitations are
recorded. Implementation phases run discovery → architecture →
interaction design → design system → one vertical slice →
expansion → hardening → evaluation; never build every screen
before validating one complete journey.

---

## 3. Themes, simplified under the rule of three

### 3.1 The theme system today

- **Exactly 3 themes, already.** `light`, `dark`, `high-contrast`
  — complete per-theme maps over every semantic `--color-*`
  role in `tokens.css`, mirrored into `generatedThemeTokens`
  (3 themes × 93 tokens at the plan's count). No component CSS
  changes per theme; a theme is a token map, nothing else.
- **`system` is not a fourth theme.** It is a resolver:
  `theme.ts` maps `system` → the OS `prefers-color-scheme`
  (dark/light) at runtime, with a live listener and cross-tab
  storage sync. The stored preference (`nextgentp_theme`) is
  `light | dark | system | high-contrast`; the effective theme
  written to `data-theme` is always one of the 3. The app root
  carries `data-theme` (the single canonical signal since #474;
  legacy root/body classes and adapters were deleted) plus
  `data-theme-preference`, and `colorScheme` is set to match.
- **High-contrast is an accessibility theme, not a styling
  variant.** It shipped as a pure token map (126 tokens, zero
  component changes). Removing it to "simplify" would remove an
  accessibility mode; the simplification lands on variants (§3.3),
  not on themes. Themes stay at 3.
- **Density is a second, independent axis with 2 modes**
  (`compact` / `comfortable`) — under the ceiling, no change.
- **Pre-paint, no flash.** A blocking `appearance-bootstrap`
  script in `index.html` stamps `data-theme` before first paint;
  `main.tsx` re-applies preferences without writing storage.
- **What "simplified" therefore means here:** the theme
  mechanism is already minimal (3 maps + 1 resolver). The
  simplification work is (a) collapsing the variant explosion
  inside components (§3.3), (b) unifying the feedback tone
  vocabulary across Notice/Toast/Badge (§3.2), and (c) removing
  the one duplicate theme implementation (the landing page,
  §4 C10).

### 3.2 One feedback vocabulary (the headline unification)

Today three components carry three overlapping tone sets:

| Component | Tones today | Call sites (JSX-tag scan, `src/client`) |
|---|---|---|
| Notice | neutral, accent, success, warning, danger, info (6) | danger 71, warning 24, success 24, info 22, neutral 5, accent 0 |
| Toast | success, info, warning, danger (4) | via `useToast()` calls, not JSX; durations: success/info 5s, warning 8s, danger persists |
| Badge | neutral, accent, success, warning, danger, info, purple, trade (8) | neutral 52, info 12, accent 10, warning 7, danger 5, success 3, trade 2, purple 1 |

**Target: 3 tones + a neutral default.** `neutral` is not a tone,
it is the absence of one (default surface + text). The three
tones, shared by all three components:

| Tone | Meaning | Absorbs |
|---|---|---|
| `success` (positive) | Completed, healthy, good | success |
| `warning` (caution) | Needs attention, degrades, may fail | warning |
| `danger` (critical) | Failed, blocked, destructive, must be seen | danger |

And the folds: `info` → default rendering (informational
content needs no tone; where emphasis is required, `warning`
carries it); `accent` → default or `success` by context
(`accent` has zero Notice call sites and is a highlight, not a
severity); `purple` (1 Badge site) and `trade` (2 Badge sites)
→ default with the meaning carried by the label text, not the
color (color is never the only indicator, §2.2).

Timing follows the tone, unchanged: positive/caution auto-dismiss
(5s/8s for Toast), critical persists. Role mapping follows the
tone, unchanged: critical/caution → `role="alert"`, positive →
`role="status"`.

**Nav badges are a separate family and a separate decision.**
`RouteBadgeType` (nav entries): `pro`, `live`, `ai`, `mcp`,
`new`, `neutral` (6). These encode product metadata (capability
flags, freshness), not severity. Options: (a) treat them as
metadata, not visual types, and map them to the 3 visual
treatments (default / live-accent / new); (b) collapse the
metadata itself to 3 (`live`, `ai`, `new`, with `pro`/`mcp`
folded into `live`). The owner decides; the collapse list
records it as open, not as done.

### 3.3 Variant audit — counts, targets, collapses

Counts are from a JSX-tag scan of `src/client` at `00778ba`
(explicit props only; defaults are uncounted, so totals are
floors). "Target" is the rule-of-three ceiling; "migration"
states what moves where.

| Family | Today | Target | Migration (usage-weighted) |
|---|---|---|---|
| **Button variant** | 7: primary 105, secondary 185, ghost 72, danger 39, accent 23, warning 10, trade 9 | **3: primary, secondary, danger** | ghost (72) → `secondary` + `subtle` tone (the quiet axis already exists: `tone="subtle"` has 108 call sites); trade (9) → `primary` (a trade CTA is a primary action); accent (23) → `primary`; warning (10) → `danger` (both are alert-role severities; severity gradation moves to text). Blast radius is largest on ghost — migrate it last, per surface. |
| **Button tone** | 2: solid (default), subtle | 2 ✓ | No change. Tone is the quiet/loud axis that makes the ghost fold work. |
| **Button size** | 3: sm, md, lg | 3 ✓ | No change. |
| **Card treatment** | 3: flat (default, everywhere), highlight (4 sites), elevated (defined, ~0 call sites) | 3 ✓ (live set: 2) | No forced change. Decision: keep `elevated` as the unused third, or retire it and hold the family at 2. Either complies; do not add a fourth. |
| **Card padding** | 4 steps: none, sm, md, lg | 3 steps | A scale, not a type — but the rule's spirit caps it: merge `none` into `sm` (a card with no padding is a layout choice, not a padding step) or drop `lg`. Owner picks; no new step may be added. |
| **Notice tone** | 6 → §3.2 | **3** | Per §3.2. `accent` (0 sites) deletes cleanly. |
| **Notice variant** | 2: box (default), strip (7 sites) | 2 ✓ | No change. Strip is the persistent page-level banner; box is the inline alert. |
| **Toast tone** | 4 → §3.2 | **3** | Merge `success` + `info`: identical 5s auto-dismiss, identical `role="status"`. No behavioral loss. |
| **Badge tone** | 8 → §3.2 | **3** | Per §3.2. `purple` (1) and `trade` (2) are the long tail; fold first. |
| **Badge size** | 3: xs (65), sm (32), md (5) | 3 ✓ | No change. |
| **PillGroup variant** | 5 colors: default (13), cyan (1), emerald/amber/purple (0) | **3 max; recommend 1** | Only `default` is live. Delete emerald/amber/purple (0 sites); keep `cyan` only if its one site genuinely needs a second color, else fold to `default`. |
| **PillGroup size** | 2: sm, md | 2 ✓ | No change. |
| **Modal size** | 5: sm (1), md (default), lg (3), xl (1), none (22) | **3 sizes + custom-panel mode** | `xl` (1 site) → `lg`. `none` is not a size: it is the custom-header mode the dialog pattern itself mandates (`size="none"` lets the panel class own sizing). Count it as a mode, not a fourth/fifth size, and the family is sm/md/lg + custom mode. |
| **Skeleton variant** | 3: text, block, circle | 3 ✓ | No change. Already at the ceiling. |
| **Spinner size** | 3: sm, md, lg | 3 ✓ | No change. |
| **Tabs / Select / TextInput size** | 2: sm, md | 2 ✓ | No change. |
| **SegmentedControl size** | 3: sm, md, lg | 3 ✓ | No change. |
| **Dialog family** | Modal + Drawer (2) + landing ⌘K palette (page-local placement only) | 2 ✓ | No change. The landing palette reuses `.modal-backdrop` + `.modal-dialog`; it is not a third dialog system. |
| **Selection mechanisms** | Tabs, SegmentedControl, PillGroup, Menu, Select (5) | Distinct purposes — no collapse, one merge candidate | Tabs navigate; SegmentedControl single-selects; Menu acts; Select is a form dropdown. PillGroup overlaps SegmentedControl (both are pill/radio selection): the merge candidate is PillGroup → SegmentedControl, or PillGroup kept for multi-select only with a documented split. Owner decides. |
| **Themes** | 3 + system resolver | 3 ✓ | No change (§3.1). |
| **Density** | 2 modes | 2 ✓ | No change. |
| **Elevation** | 3: surface, surface-raised, surface-sunken | 3 ✓ | No change. |
| **Spacing / radius / font scales** | 14 / 7 / 9 steps | Frozen | Scales, not types. No collapse mandated; no growth permitted. Any future scale is designed at ≤ 3 steps unless it is a true measurement scale (spacing, type). |

### 3.4 Collapse list — what must change (the gap list)

In priority order (usage-weighted; a collapse is a behavior
change and updates its pins in the same PR):

1. **Button variants 7 → 3.** The largest gap. `trade`,
   `accent`, `warning` fold first (42 sites combined, all
   low-risk mappings); `ghost` (72 sites) folds last via
   `secondary` + `subtle`.
2. **One feedback vocabulary.** Notice 6 + Toast 4 + Badge 8
   → 3 tones + neutral default (§3.2). Deletes `accent` (0
   Notice sites) and the Badge long tail (`purple` 1, `trade`
   2) immediately; merges `info` and `warning`/`danger` with
   text-carried severity.
3. **PillGroup colors 5 → 1 (or ≤ 3).** Three variants are
   already dead (0 sites); `cyan` (1 site) is the only question.
4. **Modal sizes 5 → 3 + custom mode.** `xl` (1 site) → `lg`;
   `none` reclassified as the custom-panel mode, not a size.
5. **Card padding 4 → 3 steps.** Owner picks which step merges.
6. **Nav badge types 6 → 3 visual treatments (decision owed).**
   Metadata vs visual treatment split (§3.2); do not collapse
   until the owner picks (a) or (b).
7. **PillGroup vs SegmentedControl overlap (decision owed).**
   Merge or document the split (multi-select vs single-select).
8. **Landing-page theme duplication (code gap, §4 C10).**
   The landing page re-implements theme toggling around the
   same generated tokens; fold it onto `theme.ts` or record it
   as the sanctioned vanilla exception.
9. **ScreenersHub bespoke tablist (code gap, §4 C3).** The
   "exactly one tab mechanism" direction is unfulfilled; the
   hub still renders its own tabs instead of the `Tabs`
   primitive.

### 3.5 What the rule does NOT collapse

- **State models** (task states, connection states, action
  states in ux-architecture §9) are domain semantics, not UX
  element types. They keep their full vocabularies.
- **Token scales** (spacing, radii, type) are measurement
  scales, frozen but not cut to 3 steps — a 3-step spacing scale
  cannot lay out an application.
- **The 23 primitives themselves** are not "types of one
  element"; each is a distinct element. The rule caps variants
  within a primitive, not the primitive count. (A future
  primitive still joins only via its own PR + inventory pin.)
- **Hub tab counts** (ScreenersHub 9, StockHub 6, OptionsHub
  10) are content, not element types. The rule governs the tab
  component's variants, not how many tabs a hub has.

### 3.6 Exceptions register — guideline deviations, identified with justification

The rule of three is a guideline (§0). These are the families
and mechanisms that don't conform, each with its justification
or with the justification still owed. §3.5 above is scope, not
exceptions: the items there are outside the guideline entirely,
not deviations from it.

| Non-conforming case | Status | Justification |
|---|---|---|
| **Nav badge metadata types (6)** — `pro`, `live`, `ai`, `mcp`, `new`, `neutral` | Proposal for #3052 (standard change; current types stand) | They encode product metadata (capability flags, freshness), not severity; the visual treatments map to 3 (default / live-accent / new). Collapsing the metadata to 3 is a standard change needing explicit owner approval per fold. |
| **PillGroup vs SegmentedControl overlap** | Proposal for #3052 (standard change; both stand) | The split is multi-select vs single-select. Merging them is a standard change needing explicit owner approval. |
| **C10: landing-page theme code** (`landing.ts` own theme maps + toggle cycle) | Recorded exception (decision 7 resolved, #3099) | The landing page is vanilla (no component runtime, so it cannot import `theme.ts`); it consumes the same generated tokens, so it cannot drift in color. |
| **C3: ScreenersHub bespoke tablist** (own tab rendering, no `Tabs` primitive, no `role="tablist"`) | Recorded exception (decision 7 resolved, #3099) | Hub tab chrome is the hub's shape by design (see the uniformity audit: hubs are divergent by shape, not non-conforming): hubs render their own URL-synced tab chrome rather than the `Tabs` primitive, and migrating it would change hub chrome behavior. Recorded as an exception to the "one mechanism" direction, not a violation. |
| **Any collapse proposal the owner rejects** (decisions 1, 4) | Becomes an exception on rejection | Justification owed at the moment of rejection — the reason the family cannot collapse, written into this register. |

---

## 4. Source map and contradictions

### 4.1 Source map — what each section consolidates

| This doc | Consolidates |
|---|---|
| §0 rule of three | Owner directive 2026-11-03 (new; no prior doc states it) |
| §1 page template | `docs/architecture/UX/design-system-01.md` §2–§3 (shell, route table, retained views, tabbed browsing, composition); `docs/agents/ux-architecture.md` §5 (information architecture), §16 (frontend–backend contracts); code: `routes.ts`, `navConfig.ts`, `deepLinks.ts`, `router.ts`, `useUrlSyncedTabs.ts`, `Chat.tsx` outlets, `LeftNavBar.tsx`, `featureFlags.tsx` |
| §2.1 layers | `design-system-01.md` §1; `docs/plans/UX/ux-token-architecture-plan.md` (phases, 3 layers, one vocabulary); `branding.ts` (#1297); `designTokens.ts`; `tokens.css` |
| §2.2 tokens | `ux-architecture.md` §6 (design tokens); plan doc (one vocabulary, shim deletion, 3 themes one mechanism); `tokens.css` header; `designTokens.ts` |
| §2.3 primitives | `design-system-01.md` §1; `src/client/components/ui/index.ts` inventory; `composable_ui_primitives.test.ts` |
| §2.4 composition | `ux-architecture.md` §8–§11, §13–§16; `design-system-01.md` §2; `gitops.md` §7 (pin rule) |
| §2.5 Toast vs Notice | `ux-architecture.md` §6 (Toasts; global toast standard, #2283 decision: transient → Toast, persistent → Notice, no `alert()`/`confirm()`) |
| §2.6 ADR-0004 | `docs/architecture/adr/0004-ux-token-architecture-no-exemptions.md` verbatim in substance |
| §2.7 gates | `design-system-01.md` §1 (gates); `gitops.md` §7, §22; the ratchet/freeze/inventory/contrast/ceiling test files |
| §2.8 DoD | `ux-architecture.md` §19–§21 |
| §3 themes | Plan doc (three themes one mechanism, theme axes); `theme.ts`; `tokens.css` theme maps; `landing.ts` theme code |
| §3.2–§3.4 audit | New work for this draft: JSX-tag scan of `src/client` at `00778ba` + the `ui/` prop types |
| Not consolidated (out of scope) | `docs/architecture/UX/schedule-surface-01.md` (schedules surface, not the system); `docs/architecture/UX/assessment-01.md` and `exceptions-01.md` (point-in-time audits — see C5, C6, treated as historical, not as rules); `docs/agents/gitops.md` delivery policy (governs process, cited, not absorbed) |

### 4.2 Contradictions — both sides, unresolved

**C1. Route and nav-entry counts.**
`design-system-01.md` §3 says "26 historical tab ids" and "20
entries that render in the nav". The tree at `00778ba` has **41
route ids and 31 nav entries** (`navOrder` 0–30). The doc is
stale by 15 routes and 11 nav entries (deep-links sequence,
StockHub/OptionsHub rework, Billing, own-pages). This draft
follows the tree. The old doc needs a counts refresh, not a
correction of the architecture.

**C2. Shell conformance frozen at S4.**
`design-system-01.md` §1/§4 says the shell list is "complete at
25 of 26 after S4" with `chat` deferred (ADR-0021). The
conformance JSON lists **26** migrated ids, but the route table
has 41 — 15 newer routes (goal-screen, review, track-record,
assets-hub, stock-hub, platform-admin, agents, billing,
checkout, payment-assurance, and others) were never added to
the list. Either the list's job ended at S4 (and the doc should
say so, with new pages conforming by the template instead of
by the list) or the list must grow to 41. Unresolved: this
draft treats the template (§1) as the conformance mechanism
for new pages and the JSON as the S4 historical record.

**C3. "Exactly one tab mechanism" vs the ScreenersHub tablist.**
`design-system-01.md` §2 says S2 "reconciles [the screener
hub's bespoke tablist] into the `Tabs` primitive… leaving
exactly one tab mechanism", with system-wide rollout beginning
from the hub as exemplar. The tree still has the hub on
`useUrlSyncedTabs` with its own tab rendering — no `Tabs`
primitive import, no `role="tablist"` in `ScreenersHub.tsx`.
Either S2 never landed for the hub, or the direction was
superseded. Unresolved: recorded here as gap §3.4 item 9, not
as done.

**C4. Inner-view deep-linking "still open" vs landed.**
`design-system-01.md` §2–§3 says generic inner-tab (`view`)
deep-linking "is S2, still open". The tree has
`SURFACE_TAB_DEFS` (14 surfaces) and the `view` param wired
through `useUrlSyncedTabs` and the deep-link catalog. The S2
work (or its successor) landed after the doc froze. This draft
follows the tree: inner-view deep-linking is done.

**C5. Exceptions-01 vs ADR-0004.**
`exceptions-01.md` (2026-10-25) audits 85 TSX files and finds
28 non-compliant (zero primitive imports + raw controls) and 16
bypassing (imports primitives but still renders raw controls),
with a remediation roadmap. ADR-0004 (2026-10-26) then made
compliance mandatory with no exemptions, and the exemption
registry is empty at draft time. The exceptions report is a
pre-ADR-0004 snapshot: its file list is not the live list, and
its roadmap is superseded by the ADR's "rework until compliant"
rule. Unresolved in the sense that no doc records which of the
28 were remediated vs which remain — a fresh audit (the freeze
allowlist is the live instrument) is the way to close it, not
an edit to the old report.

**C6. Assessment-01 vs the one-dialog / Toast systems.**
`assessment-01.md` (2026-10-25) finds modal focus-trapping gaps,
live-announcement gaps during streaming, and 24px/44px target
gaps. The Modal primitive (portal, Escape, focus trap +
restore, scroll lock) and the Toast live-region rules
(`role="alert"`/`role="status"`, no focus steal) landed after
the assessment. The assessment's findings are therefore
partially addressed; which findings remain open is not recorded
anywhere. This draft treats the assessment as historical and
the primitives as current.

**C7. Aspirational component list vs implemented primitives.**
`ux-architecture.md` §6 "Required reusable components" lists
Task card, Goal/constraint form, Plan outline, Progress summary,
Activity timeline, Evidence/source panel, Artifact viewer,
Approval card, Budget indicator, and others. The implemented
`ui/` inventory has none of those as primitives; approval cards
and evidence panels are compositions of `Card` + `Table` +
`Notice`. Either the §6 list is a product backlog (in which
case it should say so) or the compositions are the intended
fulfillment (in which case the list should name them as
compositions). Unresolved: this draft lists the implemented
inventory as the system and the §6 list as requirements those
compositions must satisfy.

**C8. Bespoke-ceiling numbers.**
An earlier summary of this program cited braces ≤ 3867 and
classes ≤ 2646. The test file at draft time
(`tests/ux_bespoke_ceiling_2177.test.ts`) reads braces ≤ 3920
and classes ≤ 2686 (bumped by the #2177 close), inline styles
≤ 807, raw labels ≤ 0. This draft follows the file. The older
numbers are stale, not a second limit.

**C9. "Every left-nav page renders inside PageShell" vs the
hub outlet.**
`design-system-01.md` §2 states the shell rule absolutely.
Hub pages render through the trading-hub outlet (§1.4), and
`chat` is deferred (ADR-0021). The shell rule is therefore
"every left-nav page renders inside PageShell, except pages
whose outlet is a retained hub by architecture and except
`chat` by product decision" — the doc's absolute phrasing
overstates it. This draft states the qualified rule.

**C10. Landing-page theme code vs one mechanism.**
The plan doc says "three themes, one mechanism: root
`data-theme` only" with legacy adapters deleted. The vanilla
landing page (`src/client/landing.ts`) inlines its own theme
maps from the generated tokens and its own toggle cycle
(dark → light → high-contrast), separate from `theme.ts`.
It consumes the same tokens, so it cannot drift in color, but
it is a second theme implementation, not the one mechanism.
Either it is the sanctioned vanilla exception (and should be
recorded as such) or it folds onto `theme.ts`. Unresolved:
gap §3.4 item 8.

**Reconciled, not contradictions (for the record):**
`design-system-01.md` says the contrast gate is "25 semantic
pairs × 3 themes" and the plan doc says "75 pairs, 0 below AA"
— the same 75 checks, counted per theme vs total. The plan
doc's "93 `--color-*` tokens" vs the 36 typed color roles in
`designTokens.ts` — the 93 counts every generated token key
(including hover/active/border/tag variants); the 36 are the
typed role list. Different counts of different sets, not a
disagreement.

---

## 5. Decisions — resolved under the conformance principle

Owner direction, 2026-11-04 (issue #3099): where a design standard
is already established, everything conforms to it. Applied to the
seven items this section previously listed as owed, that direction
resolves them as follows — none of them is an open conformance
question anymore:

- **Decisions 1–4 (collapse mappings, nav badge types, PillGroup
  vs SegmentedControl, card padding) are standard-change
  proposals, not conformance gaps.** The established standard is
  the primitives as they exist today (7 button variants, 6 nav
  badge metadata types, and so on). Conformance means the current
  variants stand. A fold changes the standard itself, so each fold
  needs its own explicit owner approval and lives as a proposal
  under #3052 (design-system consolidation implementation) — it is
  not an open decision on this document.
- **Decision 5 (placement) — RESOLVED 2026-11-04.** This document
  was placed at `docs/architecture/UX/consolidated-design-system.md`
  via issue #3096 / PR #3097 (merged 3a51d91), with
  `design-system-01.md` pointing here as its consolidated
  successor. No replacement of `ux-architecture.md` was made: it
  remains the live contract.
- **Decision 6 (C2) — RESOLVED as historical.** The S4
  shell-conformance list is a historical record of the S4
  migration. The live conformance mechanism is the #3047 gate map
  plus the page template (§1): new pages conform by construction
  (see the page scaffold), and the gate map is the list that
  grows.
- **Decision 7 (C3/C10) — RESOLVED as recorded exceptions
  (§3.6).** The ScreenersHub tablist and the landing theme are
  exceptions with justification recorded in §3.6, which under §0
  is compliant with the guideline — a documented exception is not
  a violation. Neither is wanted rework unless the owner later
  directs it as #3052 work.

A rejection of any #3052 fold likewise becomes an exception entry
in §3.6 with its justification recorded, not a violation left
open (§0).
