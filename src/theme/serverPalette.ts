/**
 * Shared server-side palette (issue #678).
 *
 * The five server-rendered surfaces — the trading email templates
 * (src/trading/email/agent.ts), the unified options email HTML
 * (src/trading/options/unifiedOptionsService.ts), the browser-agent SVG
 * artwork (src/services/browserAgent.ts), the GitHub OAuth pages
 * (src/security/githubOAuth.ts), and the /checkout/sandbox page in
 * src/server.ts — render outside the app shell, so they cannot consume
 * the client design tokens (src/client/tokens.css) as CSS variables.
 * Before #678 each carried its own private hard-coded palette; this
 * module is the single home for those values.
 *
 * OUTPUT-PRESERVING BY CONSTRUCTION: every entry holds exactly the
 * value the literals held before the migration — the rendered output
 * of the five surfaces is unchanged. The one exception is the Carbon
 * section (#3146): those values are new (a new design for one page),
 * not migrated literals, and no existing surface uses them, so prior
 * output is still unchanged. Where a historical literal equals
 * a tokens.css value (matched by VALUE against the dark theme — the
 * theme these theme-less surfaces were styled after), the entry takes
 * the token's role name and is listed in SERVER_PALETTE_TOKEN_SOURCES;
 * tests/server_palette.test.ts pins those entries to the tokens.css
 * values so the mirror cannot drift silently (the #677 pattern:
 * hand-mirrored values + a pin test, rather than extending the client
 * token generator). Entries with no token counterpart keep their
 * current values under descriptive names and are pinned the other way:
 * the test fails if one of them ever silently becomes equal to a
 * tokens.css colour without being reclassified as token-aligned.
 *
 * The `transparent` keyword is deliberately not a palette entry: it is
 * a CSS keyword, not a colour value (the #677 gate excludes it for the
 * same reason), and the two uses in the migrated files stay inline.
 */
export const SERVER_PALETTE = {
  // --- Token-aligned: surfaces & text (tokens.css, dark theme) ---
  /** --color-surface */
  surface: "#060913",
  /** --color-surface-raised */
  surfaceRaised: "#0c1222",
  /** --color-card */
  card: "#0f172a",
  /** --color-text-primary */
  textPrimary: "#f8fafc",
  /** --color-text-secondary */
  textSecondary: "#cbd5e1",
  /** --color-text-muted (same value as --color-muted-foreground) */
  textMuted: "#94a3b8",
  // --- Token-aligned: accents & semantics ---
  /** --color-accent (same value as --color-info) */
  accent: "#38bdf8",
  /** --color-danger */
  danger: "#f43f5e",
  /** --color-danger-text */
  dangerText: "#f87171",
  /** --color-warning */
  warning: "#f59e0b",
  /** --color-success-text */
  successText: "#34d399",
  /** --color-on-gradient */
  onGradient: "#ffffff",
  /** --color-sentiment-very-bearish (the down/negative red of the server surfaces) */
  sentimentVeryBearish: "#ef4444",
  // --- Token-aligned: translucent values ---
  /** --color-card-border (same value as --color-border-subtle) */
  cardBorder: "rgba(255, 255, 255, 0.08)",
  /** --color-surface-active */
  surfaceActive: "rgba(37, 99, 235, 0.2)",
  /** --color-primary-alpha */
  primaryAlpha: "rgba(99, 102, 241, 0.15)",
  /** --color-primary-border */
  primaryBorder: "rgba(99, 102, 241, 0.35)",
  /** --color-muted */
  muted: "rgba(255, 255, 255, 0.05)",

  // --- No token counterpart: slate family (borders, raised surfaces) ---
  slate800: "#1e293b",
  slate700: "#334155",
  slate600: "#475569",
  slate500: "#64748b",
  slate200: "#e2e8f0",
  slate100: "#f1f5f9",
  // --- No token counterpart: grays & deep backgrounds ---
  gray900: "#111827",
  gray100: "#f3f4f6",
  backgroundEnd: "#030712",
  /** Email page background / footer band. */
  pageBackground: "#0b0f19",
  /** Unified options email metric tiles. */
  tileBackground: "#090d16",
  /** Browser placeholder SVG background. */
  placeholderBackground: "#0a0f1d",
  /** Transaction receipt SVG gradient start (end is backgroundEnd). */
  receiptGradientStart: "#0b1120",
  // --- No token counterpart: hues the server surfaces use directly ---
  green500: "#22c55e",
  green700: "#15803d",
  red700: "#b91c1c",
  sky600: "#0284c7",
  blue900: "#1e3a8a",
  blue600: "#2563eb",
  blue500: "#3b82f6",
  blue400: "#60a5fa",
  violet400: "#a78bfa",
  amber100: "#fef3c7",
  /** The --gradient-ai stops; no standalone colour token holds them. */
  indigo500: "#6366f1",
  indigo400: "#818cf8",
  indigo950: "#1e1b4b",
  cyan500: "#06b6d4",
  // --- No token counterpart: translucent tints ---
  accentAlpha10: "rgba(56, 189, 248, 0.1)",
  accentAlpha20: "rgba(56, 189, 248, 0.2)",
  /** Also the colour component of --shadow-focus-ring, but no colour token holds it. */
  accentAlpha30: "rgba(56, 189, 248, 0.3)",
  dangerAlpha10: "rgba(239, 68, 68, 0.1)",
  roseAlpha20: "rgba(244, 63, 94, 0.2)",
  greenAlpha10: "rgba(34, 197, 94, 0.1)",
  emeraldAlpha15: "rgba(16, 185, 129, 0.15)",
  emeraldAlpha40: "rgba(16, 185, 129, 0.4)",
  slateAlpha10: "rgba(148, 163, 184, 0.1)",
  warningAlpha10: "rgba(245, 158, 11, 0.1)",
  blueAlpha40: "rgba(37, 99, 235, 0.4)",
  blackAlpha40: "rgba(0, 0, 0, 0.4)",
  blackAlpha50: "rgba(0, 0, 0, 0.5)",
  blackAlpha60: "rgba(0, 0, 0, 0.6)",
  whiteAlpha3: "rgba(255, 255, 255, 0.03)",
  whiteAlpha10: "rgba(255, 255, 255, 0.1)",
  whiteAlpha15: "rgba(255, 255, 255, 0.15)",
  indigoAlpha20: "rgba(99, 102, 241, 0.2)",
  indigoAlpha40: "rgba(99, 102, 241, 0.4)",
  /** OAuth login card glass. */
  loginCard: "rgba(17, 24, 39, 0.75)",
  /** Sandbox checkout card. */
  checkoutCard: "rgba(18, 26, 47, 0.9)",
  // --- Carbon v11 Gray 100 tokens (#3146): the /checkout/sandbox page's
  // Carbon visual system. These are Carbon's values, not tokens.css
  // values (verified: none equals a dark --color-* token), so they are
  // non-aligned entries. Carbon's button text (#ffffff) is NOT duplicated
  // here: it reuses onGradient, already token-aligned to
  // --color-on-gradient. No other surface uses these entries.
  /** Carbon Gray 100: background */
  carbonBackground: "#161616",
  /** Carbon Gray 100: layer-01 */
  carbonLayer01: "#262626",
  /** Carbon Gray 100: layer-01 hover */
  carbonLayerHover01: "#333333",
  /** Carbon Gray 100: border-subtle */
  carbonBorderSubtle: "#393939",
  /** Carbon Gray 100: text-primary */
  carbonTextPrimary: "#f4f4f4",
  /** Carbon Gray 100: text-secondary */
  carbonTextSecondary: "#c6c6c6",
  /** Carbon Gray 100: button-primary (blue 60) */
  carbonButtonPrimary: "#0f62fe",
  /** Carbon Gray 100: button-primary hover */
  carbonButtonPrimaryHover: "#0353e9",
  /** Carbon Gray 100: link-primary (blue 40) */
  carbonLinkPrimary: "#78a9ff",
  /** Carbon Gray 100: blue tag background (dark theme) */
  carbonTagBlueBg: "#002d9c",
  /** Carbon Gray 100: blue tag text (dark theme) */
  carbonTagBlueText: "#a6c8ff",
} as const;

export type ServerPaletteKey = keyof typeof SERVER_PALETTE;

/**
 * The tokens.css (dark theme) token each token-aligned entry mirrors.
 * Entries NOT listed here must not equal any dark-theme token colour
 * value; tests/server_palette.test.ts enforces both directions.
 */
export const SERVER_PALETTE_TOKEN_SOURCES: Partial<Record<ServerPaletteKey, string>> = {
  surface: "--color-surface",
  surfaceRaised: "--color-surface-raised",
  card: "--color-card",
  textPrimary: "--color-text-primary",
  textSecondary: "--color-text-secondary",
  textMuted: "--color-text-muted",
  accent: "--color-accent",
  danger: "--color-danger",
  dangerText: "--color-danger-text",
  warning: "--color-warning",
  successText: "--color-success-text",
  onGradient: "--color-on-gradient",
  sentimentVeryBearish: "--color-sentiment-very-bearish",
  cardBorder: "--color-card-border",
  surfaceActive: "--color-surface-active",
  primaryAlpha: "--color-primary-alpha",
  primaryBorder: "--color-primary-border",
  muted: "--color-muted",
};
