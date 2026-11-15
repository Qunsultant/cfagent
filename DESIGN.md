# NextGenTP Design System & Token Architecture

## Core Philosophy
**Components describe intent; themes supply appearance.**
Components must **never** use raw palette values (e.g. `#060b18`, `#1e293b`, `bg-zinc-900`) or ad-hoc per-component theme hacks. All styling must consume semantic design tokens exposed via CSS variables. When components consume semantic roles, dark/light/system theme switching, rebranding, and density changes happen cleanly and automatically without breaking page harmony or creating "dark islands".

---

## 1. Three-Layer Token Architecture

### Layer 1: Primitives (Foundational, Reusable Values)
Raw values that do not change based on theme:
- **Typography**: `--font-sans`, `--font-mono`
- **Spacing**: `--space-1` (4px), `--space-2` (8px), `--space-3` (12px), `--space-4` (16px), `--space-6` (24px), `--space-8` (32px)
- **Radii**: `--radius-xs` (4px), `--radius-sm` (6px), `--radius-md` (8px), `--radius-lg` (12px), `--radius-xl` (16px), `--radius-full` (9999px)
- **Typography Scale**: `--font-size-caption` (12px), `--font-size-body-sm` (13px), `--font-size-body` (14px), `--font-size-body-lg` (16px), `--font-size-title` (20px), `--font-size-display` (30px)

### Layer 2: Semantic Tokens (Theme-Dependent Meanings)
Theme-aware semantic tokens that adapt between **Dark** and **Light** modes:

| Semantic Role | Dark Value | Light Value | Purpose / Usage |
|---|---|---|---|
| `--color-surface` | `#060913` | `#f8fafc` | Canvas and page background |
| `--color-surface-foreground` | `#f8fafc` | `#0f172a` | Primary text on canvas |
| `--color-surface-raised` | `#0c1222` | `#ffffff` | Modals, drawers, elevated sidebars |
| `--color-surface-raised-foreground` | `#f8fafc` | `#0f172a` | Text on raised surfaces |
| `--color-surface-sunken` | `#080f24` | `#f1f5f9` | Wells, input fields, search inputs, nested panels |
| `--color-surface-sunken-foreground`| `#f8fafc` | `#0f172a` | Text in sunken wells / inputs |
| `--color-card` | `#0f172a` | `#ffffff` | Main cards, tables, containers |
| `--color-card-foreground` | `#f8fafc` | `#0f172a` | Primary card typography |
| `--color-muted` | `rgba(255,255,255,0.05)` | `#f1f5f9` | Subdued backgrounds, tags, chips |
| `--color-muted-foreground` | `#94a3b8` | `#475569` | Secondary captions, timestamps, table column headers |
| `--color-border-subtle` | `rgba(255,255,255,0.08)` | `#e2e8f0` | Dividers, card borders, subtle gridlines |
| `--color-border-medium` | `rgba(255,255,255,0.16)` | `#cbd5e1` | Input borders, active tab outlines |
| `--color-border-focus` | `rgba(56,189,248,0.6)` | `rgba(2,132,199,0.65)` | Active focus rings |
| `--color-primary` | `#10b981` | `#059669` | Primary action buttons, brand accents |
| `--color-accent` | `#38bdf8` | `#0284c7` | Secondary accents, links, callout tags |
| `--color-success` | `#10b981` | `#16a34a` | Calls, long positions, profits, positive delta |
| `--color-danger` | `#f43f5e` | `#dc2626` | Puts, short positions, losses, negative delta |
| `--color-warning` | `#f59e0b` | `#d97706` | Pending executions, warnings, cautions |
| `--color-info` | `#38bdf8` | `#0284c7` | Informational badges, guide hints |

### Layer 3: Component Tokens & Utilities
Standardized CSS utility classes consuming semantic tokens:
- `.bg-surface`, `.bg-surface-raised`, `.bg-surface-sunken`, `.bg-card`, `.bg-muted`
- `.text-primary`, `.text-secondary`, `.text-muted`, `.text-dim`, `.text-inverse`
- `.border-subtle`, `.border-medium`, `.border-focus`
- `.text-success`, `.text-danger`, `.text-warning`, `.text-info`
- `.badge-success`, `.badge-danger`, `.badge-warning`, `.badge-info`

---

## 2. Universal Design Rules

1. **Always Pair Surface and Foreground**:
   Never style a background without specifying its corresponding foreground color.
   - Using `--color-surface`? Use `--color-surface-foreground` (or `--color-text-primary`).
   - Using `--color-card`? Use `--color-card-foreground`.
   - Using `--color-muted`? Use `--color-muted-foreground`.
   - Using `--color-primary`? Use `--color-primary-foreground`.
   This guarantees accessibility across all color modes and eliminates invisible text bugs.

2. **No Raw Palette Values in Components**:
   Never write `#060b18`, `#0b1329`, or `#1e293b` in component stylesheets. Use semantic variables (`var(--color-surface)`, `var(--color-surface-sunken)`, etc.).

3. **WCAG 2.1 AA Contrast Standard**:
   All body text on light backgrounds must satisfy at least **4.5:1** contrast ratio (using `#0f172a`, `#334155`, or `#475569`). Pure white text on light backgrounds or dark grey text on dark backgrounds is strictly forbidden.

4. **Density Awareness**:
   Components should honor `--control-height`, `--input-padding`, `--table-row-height`, and `--card-padding` to support both `compact` and `comfortable` density modes.

5. **Pre-Hydration Zero Flash**:
   Theme and density preferences are resolved in `<head>` before the DOM renders via a blocking inline script, ensuring zero flash of unstyled content (FOUC).

---

## 3. Developer Quick Reference

### In React Component:
```tsx
import { SurfaceRole, tokenVar } from "./designTokens";

export function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card border-subtle" style={{ borderRadius: "var(--radius-md)", padding: "var(--card-padding)" }}>
      <span className="text-muted" style={{ fontSize: "var(--font-size-caption)" }}>{label}</span>
      <h3 className="text-primary" style={{ fontSize: "var(--font-size-title)" }}>{value}</h3>
    </div>
  );
}
```

### In CSS:
```css
/* CORRECT: Consuming semantic roles */
.custom-panel {
  background: var(--color-card);
  color: var(--color-card-foreground);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  padding: var(--space-4);
}

/* WRONG: Hardcoded palette colors */
.custom-panel {
  background: #060b18; /* DO NOT DO THIS */
  color: #f8fafc;     /* DO NOT DO THIS */
}
```

## 4. UI Primitives (`src/client/components/ui/`)

Surfaces are composed from the shared primitives in `src/client/components/ui/`
(issue #492) instead of re-implementing recurring elements per page. Every
primitive consumes semantic tokens only (styles in `components/ui/primitives.css`,
imported once by `main.tsx`), so each one follows dark / light / system /
high-contrast by construction, and is pinned by
`tests/composable_ui_primitives.test.ts`.

| Primitive | Role |
|---|---|
| `SegmentedControl` | Single-selection radio group (sizes, badges, roving-tabindex keys) |
| `PillGroup` | Selection pill group (tone variants) |
| `Badge` | Status/label pill (semantic tones, optional dot) |
| `Button` | Action button (primary/secondary/ghost/danger/trade, loading state) |
| `Spinner` | Loading indicator (`role="status"` + label) |
| `Skeleton` | Decorative loading placeholder (text/block/circle) |
| `EmptyState` | Icon/title/description/action empty block (optional framed panel) |
| `Card` | Surface container (flat/elevated, padding scale) |
| `Notice` | Inline banner/alert (tones, box/strip, dismissible) |
| `Tabs` + `TabPanel` | WAI-ARIA tablist/tabpanel pair |
| `TextInput` / `Select` | Labeled form controls (hint/error wiring via shared `FieldShell`) |
| `Modal` | Dialog on the Universal Modal System classes (portal, Esc, focus trap) |
| `Table` | Semantic data table from a column config (empty slot) |

Rules for new work:

- A repeated element becomes a primitive (with tests), never a page-local copy.
- New primitives are added to the reviewed inventory in
  `tests/ui_primitives_inventory.test.ts` in the same PR; the pin fails on
  unreviewed component files in `components/ui/` and on any same-named
  component defined elsewhere in `src/client`.
- Accessibility follows `docs/architecture/UX/ux-architecture.md` §13: visible focus,
  keyboard patterns per WAI-ARIA, status never carried by color alone,
  `prefers-reduced-motion` honored.
