# 06 — Client and UX code

**Purpose.** The code-facing subset of the UX rules: what client code is
built from, where values come from, and which shell every page renders in.
This file is a short operational extract with pointers; the UX programme's
canonical statement is ADR 0004 (UX token architecture), and nothing here
restates it at length.

**Canonical sources.** ADR 0004 (`0004-ux-token-architecture-no-exemptions.md`
— canonical for F1/F2; note ADR 0004 exists twice, see the README's
known-conflicts table), repo AGENTS.md (UX paragraph), gitops §7 "No drift"
item 2, `docs/architecture/standards/standards.md` §§9.1–9.2, ADR 0021,
`docs/agents/tech-standards.md` §10.

## F1 — UI is built only from the `ui/` primitives

**Definition.** Every surface is built from the primitives in
`src/client/components/ui/` — including composition-only surfaces, with no
exemptions. Raw HTML controls with hand-rolled inline styles are violations.
**Status.** ENFORCED — `tests/ui_primitives_inventory.test.ts` (fixed
inventory of primitive exports) and `tests/ux_primitives_pin_negative_1772.test.ts`.
**Conformance at `9925ead8`.** Pins green at base.

## F2 — No raw color literals outside the token sources

**Definition.** Raw color literals appear only in the token sources
(`tokens.css`, `designTokens.ts`). Theming is via `data-theme` only; theme-
class selectors outside the token sources are violations.
**Status.** ENFORCED — `tests/ux_token_coverage_ratchet.test.ts`. This gate
is **absolute**: the count is fixed at zero, not shrink-only.
**Conformance at `9925ead8`.** Zero raw literals at base.

## F3 — The token mirror stays in sync, and coverage stays zero

**Definition.** `tokens.css` ↔ `designTokens.ts` parity is generated, not
hand-maintained, and is checked in `npm run check`; the client
token-coverage total is 0.
**Status.** ENFORCED — `scripts/gen-design-tokens.mjs --check` (in
`npm run check`); gitops §8 pre-push battery (`scripts/token-coverage.mjs`,
TOTAL raw = 0).
**Conformance at `9925ead8`.** Checks green at base.

## F4 — Density and spacing values come from tokens

**Definition.** Density and spacing values come from tokens
(`--control-height`, `--space-*`, …). Hardcoded density literals are
violations.
**Status.** ENFORCED — `tests/ux_density_ratchet_1580.test.ts` (shrink-only
ratchet).
**Conformance at `9925ead8`.** Baseline: the ratchet's recorded ceilings at
base, shrink-only, cleared on touch.

## F5 — Left-nav pages render inside `PageShell`

**Definition.** Left-nav pages render inside the `PageShell` primitive under
the route-table navigation standard. The chat page is the one recorded
deferral, by owner decision; it is a named deferral, not an exemption other
pages may claim.
**Status.** DOCUMENTED — `docs/architecture/standards/standards.md` §9.1;
ADR 0021.
**Conformance at `9925ead8`.** All left-nav pages except the recorded chat
deferral; not pinned.

## F6 — Accessibility target: WCAG 2.2 AA

**Definition.** Supported journeys meet WCAG 2.2 AA: semantic structure,
keyboard access, visible focus, accessible names and errors, contrast, and
non-color status indicators.
**Status.** DOCUMENTED — `docs/agents/tech-standards.md` §10;
`standards.md` §9.2. `tests/theme_preferences.test.ts` pins theme parity
only; the axe-core CI gate proposed in `anti-drift.md` §3 does not exist.
**Conformance at `9925ead8`.** Not mechanically measured. The platform-level
accessibility, time, and i18n-readiness statement is in `15`.
