/**
 * Issue #3926 (slice: lint + coverage) — the lint ratchet.
 *
 * The repository had no linter. A repo-wide ESLint adoption would arrive as a
 * four-figure error backlog and block every PR until it was cleared, so the
 * decision recorded in docs/agents/gitops.md §7 is a **ratchet**:
 *
 *   - this config enables only defect-class rules — never style, never naming,
 *     never formatting — so a finding is always something worth fixing;
 *   - the gate lints **only the files a PR changes** (scripts/lint-changed.mjs),
 *     so untouched legacy files never block anyone;
 *   - new code must be clean; the backlog is paid down by touching it.
 *
 * Type-aware rules are deliberately absent: they need a program build and take
 * minutes, which is the wrong trade for a fast gate. `tsc --noEmit` already owns
 * type correctness.
 */
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

/** Defect-class rules only. A rule belongs here if a finding is a bug. */
const DEFECT_RULES = {
  "no-debugger": "error",
  "no-dupe-args": "error",
  "no-dupe-keys": "error",
  "no-duplicate-case": "error",
  "no-unreachable": "error",
  "no-unsafe-negation": "error",
  "no-eval": "error",
  "no-implied-eval": "error",
  "no-new-func": "error",
  "no-cond-assign": ["error", "except-parens"],
  "no-constant-binary-expression": "error",
  "no-self-assign": "error",
  "no-self-compare": "error",
  "no-async-promise-executor": "error",
  "no-template-curly-in-string": "error",
  "no-unmodified-loop-condition": "error",
  "valid-typeof": "error",
  "no-sparse-arrays": "error",
  "no-fallthrough": "error",
};

/** Rules that are correct for plain JS but false-positive on TypeScript. */
const SCRIPT_ONLY_RULES = {
  // Core no-redeclare fires on a TS overload set; tsc owns redeclaration.
  "no-redeclare": "error",
};

export default [
  {
    ignores: [
      "dist/**",
      "dist-*/**",
      "coverage/**",
      "node_modules/**",
      ".worktrees/**",
      ".wrangler/**",
      "**/*.d.ts",
    ],
  },
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...DEFECT_RULES,
      // Declared so the file-local disable directives stay valid; the rule
      // itself is intentionally off until the pay-down slice decides on it.
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs", "scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: { ...DEFECT_RULES, ...SCRIPT_ONLY_RULES },
  },
];
