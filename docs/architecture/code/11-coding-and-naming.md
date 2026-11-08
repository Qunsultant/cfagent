# 11 — Coding and naming

**Purpose.** General code discipline — type strictness, suppression bans, the
`any` ratchet, the async idiom, lint/format tooling — and the naming standard
for files, types, functions, and tests. The naming rules below were measured
practice with no document behind them; this file ratifies them.

**Canonical sources.** `tsconfig.json`, `package.json` scripts,
`docs/agents/tech-standards.md` (a standards-*selection* policy; its
code-level rules are §§5–6, harvested in `03`/`05`), gitops §§5–6, §22
(process naming — M8).

## L1 — TypeScript compiles under `strict: true`, zero errors, every PR

**Definition.** `tsc --noEmit` runs under `strict: true` (with
`forceConsistentCasingInFileNames: true`) and must report zero errors on
every PR. It is a required gate (`07` G7).
**Status.** ENFORCED — `tsconfig.json`; CI Fast gates.
**Conformance at `9925ead8`.** The gate itself: main is green at base.

## L2 — Stricter-than-strict flags are ruled on, one by one

**Definition.** Every stricter-than-strict flag is recorded in the toolchain
register as **on**, or **deliberately off with a stated reason** — never
simply absent. The low-blast-radius flags are enabled;
`noUncheckedIndexedAccess` is staged as its own slice because its blast
radius is the whole tree. `skipLibCheck: true` and `allowJs: true` stand as
recorded settings until separately ruled.
**Status.** ADOPTED-PENDING-IMPLEMENTATION — at base, no flag in the
candidate set (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitReturns`, …) had ever been adopted or ruled on.
**Conformance at `9925ead8`.** Baseline: all candidate flags absent at base;
conformance is the register existing with a ruling per flag, then the staged
enables landing.

## L3 — No TypeScript suppression comments in `src/`

**Definition.** `@ts-ignore`, `@ts-expect-error`, and `@ts-nocheck` do not
appear in `src/`. A type problem is fixed, or the code is restructured —
never suppressed.
**Status.** DOCUMENTED — ratified here from practice; absolute in fact,
unpinned in machinery.
**Conformance at `9925ead8`.** **0** occurrences (grep over `src/`) —
absolute conformance at base. Any future occurrence is a violation on sight
and a candidate for a fixed-at-zero pin on the F2 pattern (`06`).

## L4 — `any` is banned in new and touched code; the existing count only shrinks

**Definition.** `any` is not used as a type escape (`: any`, `as any`,
`<any>`, `any[]`) in new code, and not in any file a change touches (touch
conformance, README). The existing tree count is held in a per-file
shrink-only ratchet on the C4 pattern (`03`): ceilings only decrease, and a
file that reaches zero is locked at zero.
**Status.** ADOPTED-PENDING-IMPLEMENTATION — no rule and no baseline existed
at base; this standard creates both.
**Conformance at `9925ead8`.** Baseline: 1,625 grep lines matching
`: any` / `<any>` / `as any` / `any[]`; **275 of 1,574 files** (17.5%)
contain at least one (200 files with `: any`, 169 with `as any`, 51 with
`any[]`). Shrink-only once the ratchet lands, cleared on touch.

## L5 — Lint and format tooling: ESLint + typescript-eslint + Prettier

**Definition (ruling, 2026-11-08).** The adopted tooling standard is: ESLint
flat config with typescript-eslint's type-checked ruleset, plus Prettier for
formatting, run in `npm run check` and gated in CI. Lint defines import
order, style, and dead-code rules; format is Prettier's, not hand-kept.
**Status.** ADOPTED-PENDING-IMPLEMENTATION — flagged plainly: **no linter or
formatter exists in the repository today.** At base there is no
`eslint.config.*`, `.eslintrc*`, `biome.json`, or `.prettierrc*`, and no
`lint`/`format` script; `npm run check` is token check + typecheck + tests +
build. This standard must not be cited as in force until the tooling lands.
**Conformance at `9925ead8`.** Baseline: zero tooling at base; 30 stale
`eslint-disable` comments remain in `src/` from an earlier regime and are
baseline rows for the adoption slice.

## L6 — Async code uses `async`/`await`

**Definition.** Asynchronous code is written with `async`/`await`.
`.then()` chains are not written.
**Status.** DOCUMENTED — ratified here from practice.
**Conformance at `9925ead8`.** `.then(` occurrences in `src/**/*.ts`: 26,
against 7,407 `await` — 99.7% of the pair. The 26 are baseline exceptions,
cleared on touch.

## L7 — External standards come from the selection register

**Definition.** Where this set adopts an external framework's code-shaped
rules (secure SDLC, supply chain, reliability baselines), the adoption is
recorded in the selection register, `docs/agents/tech-standards.md`
§§11–13, §17. This set extracts only the register's code-shaped rules and
points back for the rest; it does not restate the register.
**Status.** DOCUMENTED.
**Conformance at `9925ead8`.** Pointer standard; no separate measurement.

## The naming standard (M)

No repo document stated a code-naming standard before this set. The
definitions below are the measured practice, ratified. Statuses are
DOCUMENTED (ratified by this file); measurements are the filename and
identifier censuses at base, methods stated per rule.

## M1 — Component files are `PascalCase.tsx`

**Definition.** React component files under `src/client/` are named
`PascalCase.tsx`.
**Conformance at `9925ead8`.** 205 of 208 client `.tsx` files conform —
**98.6%** (filename census). The 3 non-conforming files are baseline rows,
cleared on touch.

## M2 — Non-client source files are `camelCase.ts`

**Definition.** Non-client, non-test `.ts` files start lowercase
(`camelCase.ts`).
**Conformance at `9925ead8`.** 1,250 of 1,250 — **100%** (filename census).

## M3 — Ports are `*Port`; adapters are `*Adapter`

**Definition.** Port interfaces are named with the `Port` suffix; adapter
classes with the `Adapter` suffix. The suffix is the architecture's
vocabulary (`01` A1/A2): a reader can tell a contract from its
implementation by name.
**Conformance at `9925ead8`.** 80 `*Port` interfaces and 122 `*Adapter`
classes (identifier census).

## M4 — Module-level constants are `UPPER_SNAKE_CASE`

**Definition.** Module-level constants are named `UPPER_SNAKE_CASE`.
**Conformance at `9925ead8`.** 1,934 distinct `UPPER_SNAKE` constant names
(identifier census).

## M5 — Types are `PascalCase`; exported functions are `camelCase`

**Definition.** Type and interface names are `PascalCase`; exported function
names are `camelCase`.
**Conformance at `9925ead8`.** Types/interfaces: 6,527 PascalCase vs 255
not — **96.2%**. Exported functions: 4,041 camelCase-initial vs 12 not —
**99.7%** (identifier census; the 255 includes string-literal type aliases
and similar edge shapes, to be refined by a census-time audit rather than
assumed to be violations).

## M6 — Hooks are named `use*`

**Definition.** React hooks are named with the `use` prefix.
**Conformance at `9925ead8`.** 19 `use*` hook definitions under
`src/client/`; no counter-examples found in the same census.

## M7 — Tests live in root `tests/`, snake_case, issue-tagged

**Definition.** All tests live in the repository-root `tests/` directory —
never inside `src/`. Test files are named in `snake_case` describing the
surface, carrying the issue or programme tag:
`<surface>_<issue>.test.ts` (e.g. `neutrality_census_3525`,
`x402_premium_end_to_end_2406`).
**Conformance at `9925ead8`.** 1,363 `*.test.ts` files in `tests/` (1,565
files total there). The directory and the `.test.ts` suffix are 100%; the
tagged pattern is the overwhelming norm — the exact tag-conformance
percentage is a census-time count, not asserted here.

## M8 — Process naming belongs to gitops

**Definition.** Issue, branch, changelog-fragment, and PR-title naming
follow gitops §§5–6 and §22. This file does not restate them.
**Status.** DOCUMENTED (cross-reference).
**Conformance at `9925ead8`.** Per gitops.
