> **Filed into the repo 2026-11-16** (issue #4792) — copy of `~/workspace/ux-framework-survey.md` as written on its stated base (2026-11-04). Survey body below unchanged.

# UX Framework Survey — requirements baseline + build-vs-reuse decision

Survey for Ceos, 2026-11-04. Direct answer to: "you have created so
many issues but never solved the real problem — solve it forever."
The failure mode is named first: issues were paper because the two
foundation decisions were never made — (1) what the framework MUST
satisfy, as requirements rather than aspirations, and (2) what to
reuse vs build. This document makes both, with evidence. It amends
the template program (filed #3131–#3140 under #2150): #3131 carries
this baseline; #3132–#3137 inherit it.

## 1. Bare-minimum requirements (all discussion points, as requirements)

Every requirement has an enforcement mechanism. A requirement
without a gate or test is an aspiration, and aspirations are how we
got here.

| # | Requirement | Source | Enforcement |
|---|---|---|---|
| R1 | Atomic levels, strict direction: pages → templates → organisms → molecules → atoms. No page without a template; no template without organisms. | Brad Frost, atomic design | Route→template gate; template conformance pins |
| R2 | Tokens are the ONLY source of truth, DTCG three tiers (primitive → semantic → component). No raw color/length/radius/hex in any component or page. | W3C DTCG 2025.10 | Token ratchet (pattern-matches raw values); token pipeline generates tokens.css from tokens.json |
| R3 | ONE type system: one font family stack, one type scale expressed as roles (display/headline/title/body/label/caption), no per-page font choices, no `!important` font overrides. | HIG type scale; M3 type scale | Font token pin (exactly one family token consumed); `!important` font rule fails CI |
| R4 | Adaptive layouts: compact/medium/expanded breakpoints; canonical layouts (workspace, list-detail, feed). No fixed-size locking; layouts flex between breakpoints. | Material 3 adaptive | WorkspaceGrid variants; breakpoint pin tests |
| R5 | 8-pt grid, 44-pt minimum targets, standard margins. | Apple HIG | Spacing-scale-only layout (LayoutGap); target-size pin on interactive primitives |
| R6 | Model-driven: page structure as data (nav-config extended to sections/cards); template changes re-render every page; agents emit template JSON only, never bespoke JSX. | Model-driven / config-driven UI; #3082 | Model schema pin; agent-output validator |
| R7 | Chrome host-applied (page/tab/nested); components never branch on host; no bare variants. | #3125 | Three-host pin tests |
| R8 | Rule of three: ≤3 button types, ≤3 card treatments (work/summary/detail), ≤3 header treatments. | Ceos's guideline | Variant-count pins |
| R9 | WCAG 2.2 AA + Nielsen Norman heuristics as acceptance tests (status visibility, user control incl. retained tabs, consistency, recognition over recall, minimalist aesthetic). | WCAG; NN/g | axe in CI; heuristic checklist on migrated pages |
| R10 | Governance + measurement: named owner (CPO lane), contribution/deprecation process, quarterly audit, adoption metrics (routes on template %, bespoke classes → 0, inline styles → 0). | Design-system governance practice | Quarterly audit issue; adoption pins in CI |
| R11 | Reuse rule: reuse solved problems, build only what's ours (brand tokens, trading template/organisms, gates, model). | Build-vs-buy practice | §3 decision table is the allow-list |
| R12 | Propagation proof: every framework change ships with a propagation test — change a token or the template and show all pages re-render; visual regression diff empty except intended changes. | "Solve it forever" | Visual regression in CI (Storybook + Chromatic/Playwright) |

## 2. Our stack reality (verified, not assumed)

- React 19, Vite 6, TypeScript 5.7, Cloudflare Workers. NO Tailwind
  (zero mentions in package.json, no tailwind/postcss config).
- 26 custom primitives + tokens.css + gates, all working and tested.
  This is sunk investment that works; it is not the problem.
- 26 CSS files; styles.css ~14,425 lines grandfathered; 24
  grandfathered bespoke classes + hub CSS. This IS the drift surface.
- **Font bug, root-caused:** tokens.css defines
  `--font-family-base` (Inter stack) AND styles.css line 742 forces
  `font-family: 'Inter', ... !important`, while other rules consume
  `var(--font-sans)` (styles.css line 1482) and `var(--font-mono)`.
  Two font token names + `!important` overrides = fonts appear
  differently per page. R3 exists because of this line, not in
  spite of it.
- Brand is NextGenTP; #2150 decided: no external design system.

## 3. Survey: what reusable exists, and the verdict for us

### Component libraries

| Option | What it is | What it solves | Verdict for us |
|---|---|---|---|
| shadcn/ui | Copy-paste components (you own the code) on Radix behavior + Tailwind styling; CSS-variable semantic tokens; cva variants; cn() merging. The 2026 default for NEW projects. | Accessible components with full code ownership, zero dependency lock-in. | NO as a whole: it requires Tailwind v4, which means migrating 14k lines of CSS + 26 primitives to Tailwind — a styling-layer rewrite, not reuse. YES to its patterns: semantic CSS-variable tokens, cva-style variants, cn() merging, data-slot hooks. |
| Radix Primitives | Headless, unstyled behavior: focus traps, keyboard nav, ARIA, portals. Zero styling; you supply the visual layer. Used by Vercel, Linear, Supabase; 130M+ monthly downloads. | The hard, easy-to-get-wrong part (accessible behavior) without inheriting anyone's look. | YES — adopt as the behavior layer UNDER our primitives, incrementally: new/changed interactive primitives (dialog, menu, popover, combobox) use Radix; existing 26 are NOT rewritten in a big bang. This is reuse that cannot fight our system, because Radix has no visual opinions. |
| Base UI | Headless, newer (v1 Dec 2025), shadcn's second base. | Same class as Radix, less battle-tested. | FALLBACK only. Radix is the pick; Base UI stays noted, not adopted. |
| MUI / Mantine / Chakra (styled kits) | Finished, themeable, pre-styled components. MUI: most installed, Material look, 80–200KB. Mantine: full-featured, less opinion. Chakra: style props, fast prototyping. | Fastest start for a new app. | NO: they impose someone else's visual identity, cost the most to restyle later, and violate the #2150 no-external-system decision + NextGenTP brand. Styled kits are the fastest way to look like everyone else. |
| Carbon / Polaris / Spectrum (reference systems) | IBM/Shopify/Adobe's full design systems. | How mature systems document tokens, patterns, governance. | REFERENCE ONLY: steal their governance + documentation patterns, not their components. |

### Tooling (reuse, not components)

| Tool | Verdict |
|---|---|
| Style Dictionary / Tokens Studio (DTCG pipeline) | YES — tokens.json becomes the single source of truth; tokens.css is GENERATED, never hand-edited. This is what makes R2 mechanical instead of aspirational. Folds into #3135. |
| Storybook + Chromatic (or Percy/Playwright) | YES — component workshop + living docs + visual regression + axe a11y in CI. Docs render the real components, so docs cannot drift from code; regression diffs catch pixel drift unit tests miss. Folds into #3136. This is R12's proof mechanism. |
| Figma variables / Tokens Studio sync | LATER — only if a design tool enters the loop; no designer tooling exists today, so no Figma dependency is introduced now. |

## 4. The reuse decision (layered, final)

- **Behavior layer: REUSE (Radix).** Accessible behavior is a solved
  problem; hand-rolling it (our Modal, menus, portaled dialogs) is
  where a11y bugs live.
- **Styling layer: OURS, tokenized (DTCG pipeline).** Our tokens,
  our brand, our radius/shadow/type. No Tailwind migration, no
  styled kit.
- **Workshop/docs/proof layer: REUSE (Storybook + visual
  regression + axe).** Documentation and proof are solved problems.
- **Template/organisms/gates/model layer: OURS.** Nobody sells a
  trading-workflow template. PageTemplate, the 10 organisms, the
  gates, and the nav-config model are the framework — this is the
  part that must be built, and it is exactly #3131–#3140.
- **What we stop doing:** hand-rolled interactive behavior,
  hand-edited tokens.css, bespoke layout classes, per-page fonts,
  docs that describe components instead of rendering them.

## 5. "Solve it forever" — the mechanism, not a cleanup

A one-time migration decays without four things, and the framework
is defined by them:

1. **Single source of truth:** tokens.json (generates tokens.css),
   PageTemplate (all pages render it), nav-config model (page
   structure as data). Two places claiming truth for one element
   is where drift starts; the framework has one place per element.
2. **Enforcement in CI:** route→template gate, token ratchet,
   font pin, variant-count pins, bespoke-layout freeze, three-host
   pins. The consistent path is the only path that merges.
3. **Proof in CI:** visual regression (Storybook stories for every
   primitive/organism/template) + axe + pin tests. A framework
   change that moves a pixel shows up as a diff; an intended
   change shows up as exactly that diff and nothing else.
4. **Ownership + audit:** CPO lane owns the framework; quarterly
   audit (component inventory, drift flags, adoption metrics);
   contribution/deprecation process (deprecate with successor,
   never silent deletion — the existing gate). A system without an
   owner is a public park: everyone uses it, nobody maintains it.

When all four hold, a template change propagates because there is
no other way for a page to render — not because someone remembered
to update 43 pages. That is the forever part.

## 6. Amended program (no new issues)

- #3131 carries this baseline (R1–R12) + the reuse decision.
- #3132–#3133: organisms use Radix for behavior where the
  organism is interactive; visual layer stays our tokens.
- #3135: includes the DTCG token pipeline (tokens.json →
  tokens.css), not just tier discipline.
- #3136: includes Storybook workshop + visual regression + axe
  in CI, not just gates.
- #3137: scaffold emits template pages (unchanged scope).
- #3138–#3140: Wave 1 migrations (unchanged scope, zero behavior
  change + UAT each).
- Explicitly NOT done: Tailwind migration, styled-kit adoption,
  big-bang primitive rewrite, Figma dependency, rebrand.
