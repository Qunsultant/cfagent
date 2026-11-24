/** Typed semantic tokens and density preference compatibility APIs. */
export { BRAND, getBrand, type BrandConfig, type BrandEcosystemAgent } from "./branding";
export const colorRoles = [
  "surface", "surface-foreground", "surface-raised", "surface-raised-foreground",
  "surface-sunken", "surface-sunken-foreground", "card", "card-foreground",
  "muted", "muted-foreground", "input", "input-foreground", "input-border",
  "text-primary", "text-secondary", "text-muted", "text-dim", "text-inverse",
  "border-subtle", "border-medium", "border-focus",
  "accent", "accent-contrast", "primary", "primary-foreground",
  "danger", "danger-foreground", "success", "success-foreground",
  "warning", "warning-foreground", "info", "info-foreground",
] as const;
export type ColorRole = (typeof colorRoles)[number];

export const surfaceRoles = ["surface", "surface-raised", "surface-sunken", "card", "muted"] as const;
export type SurfaceRole = (typeof surfaceRoles)[number];

export function tokenVar(role: ColorRole): string {
  return `var(--color-${role})`;
}

export type DensityMode = "compact" | "comfortable";
export const DENSITY_STORAGE_KEY = "nextgentp_density";

export function normalizeDensity(value: unknown): DensityMode {
  return value === "compact" || value === "comfortable" ? value : "comfortable";
}

export function getStoredDensity(): DensityMode {
  if (typeof window === "undefined") return "comfortable";
  try {
    return normalizeDensity(localStorage.getItem(DENSITY_STORAGE_KEY));
  } catch {
    return "comfortable";
  }
}

export function applyDensityToDocument(mode: DensityMode): void {
  if (typeof document === "undefined") return;
  const density = normalizeDensity(mode);
  document.documentElement.setAttribute("data-density", density);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("density-changed", { detail: { density } }));
  }
}

export function persistDensity(mode: DensityMode): void {
  try {
    if (typeof window !== "undefined") localStorage.setItem(DENSITY_STORAGE_KEY, normalizeDensity(mode));
  } catch {
    // Document preferences remain usable without storage.
  }
}

/** Compatibility API for explicit user changes. */
export function applyDensity(mode: DensityMode): void {
  applyDensityToDocument(mode);
  persistDensity(mode);
}

export function initDensityListener(): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: StorageEvent) => {
    if (event.key !== DENSITY_STORAGE_KEY && event.key !== null) return;
    try {
      if (event.storageArea && event.storageArea !== localStorage) return;
    } catch {
      return;
    }
    applyDensityToDocument(event.key === null ? getStoredDensity() : normalizeDensity(event.newValue));
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

/* BEGIN GENERATED TOKENS — scripts/gen-design-tokens.mjs — do not edit by hand */
/** Semantic --color-* values per theme, generated from tokens.css. */
export const generatedThemeTokens: Record<"dark" | "light" | "high-contrast", Record<string, string>> = {
  "dark": {
    "--color-surface": "#060913",
    "--color-surface-foreground": "#f8fafc",
    "--color-surface-raised": "#0c1222",
    "--color-surface-raised-foreground": "#f8fafc",
    "--color-surface-sunken": "#080f24",
    "--color-surface-sunken-foreground": "#f8fafc",
    "--color-surface-hover": "rgba(26, 37, 65, 0.75)",
    "--color-surface-active": "rgba(37, 99, 235, 0.2)",
    "--color-card": "#0f172a",
    "--color-card-foreground": "#f8fafc",
    "--color-card-border": "rgba(255, 255, 255, 0.08)",
    "--color-card-hover": "rgba(26, 37, 65, 0.9)",
    "--color-card-elevated": "#162038",
    "--color-input": "rgba(15, 23, 42, 0.85)",
    "--color-input-foreground": "#f8fafc",
    "--color-input-border": "rgba(255, 255, 255, 0.35)",
    "--color-input-focus-border": "rgba(56, 189, 248, 0.6)",
    "--color-muted": "rgba(255, 255, 255, 0.05)",
    "--color-muted-foreground": "#94a3b8",
    "--color-tag": "rgba(255, 255, 255, 0.06)",
    "--color-tag-foreground": "#cbd5e1",
    "--color-text-primary": "#f8fafc",
    "--color-text-secondary": "#cbd5e1",
    "--color-text-muted": "#94a3b8",
    "--color-text-dim": "#7c8fb0",
    "--color-text-inverse": "#0f172a",
    "--color-border-subtle": "rgba(255, 255, 255, 0.08)",
    "--color-border-medium": "rgba(255, 255, 255, 0.16)",
    "--color-border-strong": "rgba(255, 255, 255, 0.28)",
    "--color-border-focus": "rgba(56, 189, 248, 0.6)",
    "--color-overlay": "rgba(0, 0, 0, 0.75)",
    "--color-primary": "#10b981",
    "--color-primary-alpha": "rgba(99, 102, 241, 0.15)",
    "--color-primary-foreground": "#04241c",
    "--color-accent": "#38bdf8",
    "--color-accent-contrast": "#060913",
    "--color-accent-subtle": "rgba(56, 189, 248, 0.15)",
    "--color-success": "#10b981",
    "--color-success-foreground": "#04241c",
    "--color-success-subtle": "rgba(16, 185, 129, 0.14)",
    "--color-primary-hover": "#059669",
    "--color-success-hover": "#059669",
    "--color-danger": "#f43f5e",
    "--color-danger-foreground": "#2e0a10",
    "--color-danger-subtle": "rgba(244, 63, 94, 0.14)",
    "--color-warning": "#f59e0b",
    "--color-warning-foreground": "#060913",
    "--color-warning-subtle": "rgba(245, 158, 11, 0.14)",
    "--color-info": "#38bdf8",
    "--color-info-foreground": "#060913",
    "--color-info-subtle": "rgba(56, 189, 248, 0.14)",
    "--color-primary-border": "rgba(99, 102, 241, 0.35)",
    "--color-purple-subtle": "rgba(168, 85, 247, 0.15)",
    "--color-purple-border": "rgba(168, 85, 247, 0.35)",
    "--color-accent-border": "rgba(56, 189, 248, 0.35)",
    "--color-success-border": "rgba(16, 185, 129, 0.35)",
    "--color-danger-border": "rgba(239, 68, 68, 0.35)",
    "--color-warning-border": "rgba(245, 158, 11, 0.35)",
    "--color-trade-subtle": "rgba(234, 88, 12, 0.14)",
    "--color-trade": "#ea580c",
    "--color-trade-deep": "#c2410c",
    "--color-on-gradient": "#ffffff",
    "--color-success-text": "#34d399",
    "--color-danger-text": "#f87171",
    "--color-warning-text": "#fbbf24",
    "--color-indigo-text": "#a5b4fc",
    "--color-purple-text": "#c084fc",
    "--color-info-text": "#7dd3fc",
    "--color-purple": "#a855f7",
    "--color-purple-foreground": "#060913",
    "--color-orange": "#f97316",
    "--color-sentiment-all": "#38bdf8",
    "--color-sentiment-all-subtle": "rgba(56, 189, 248, 0.15)",
    "--color-sentiment-all-border": "rgba(56, 189, 248, 0.4)",
    "--color-sentiment-very-bearish": "#ef4444",
    "--color-sentiment-very-bearish-subtle": "rgba(239, 68, 68, 0.18)",
    "--color-sentiment-very-bearish-border": "rgba(239, 68, 68, 0.45)",
    "--color-sentiment-bearish": "#f87171",
    "--color-sentiment-bearish-subtle": "rgba(248, 113, 113, 0.16)",
    "--color-sentiment-bearish-border": "rgba(248, 113, 113, 0.4)",
    "--color-sentiment-neutral": "#cbd5e1",
    "--color-sentiment-neutral-subtle": "rgba(148, 163, 184, 0.16)",
    "--color-sentiment-neutral-border": "rgba(148, 163, 184, 0.4)",
    "--color-sentiment-directional": "#c084fc",
    "--color-sentiment-directional-subtle": "rgba(192, 132, 252, 0.16)",
    "--color-sentiment-directional-border": "rgba(192, 132, 252, 0.4)",
    "--color-sentiment-bullish": "#4ade80",
    "--color-sentiment-bullish-subtle": "rgba(74, 222, 128, 0.16)",
    "--color-sentiment-bullish-border": "rgba(74, 222, 128, 0.4)",
    "--color-sentiment-very-bullish": "#10b981",
    "--color-sentiment-very-bullish-subtle": "rgba(16, 185, 129, 0.18)",
    "--color-sentiment-very-bullish-border": "rgba(16, 185, 129, 0.45)",
    "--color-bullish": "var(--color-sentiment-bullish)",
    "--color-bearish": "var(--color-sentiment-bearish)",
    "--color-gain": "#10b981",
    "--color-gain-foreground": "#04241c",
    "--color-gain-subtle": "rgba(16, 185, 129, 0.12)",
    "--color-gain-border": "rgba(16, 185, 129, 0.28)",
    "--color-loss": "#f43f5e",
    "--color-loss-foreground": "#2e0a10",
    "--color-loss-subtle": "rgba(244, 63, 94, 0.12)",
    "--color-loss-border": "rgba(244, 63, 94, 0.28)",
    "--color-surface-glass": "rgba(15, 23, 42, 0.82)",
    "--color-surface-glass-border": "rgba(255, 255, 255, 0.08)",
    "--color-night": "#060913",
    "--color-night-border": "rgba(255, 255, 255, 0.08)"
  },
  "light": {
    "--color-surface": "#f8fafc",
    "--color-surface-foreground": "#0f172a",
    "--color-surface-raised": "#ffffff",
    "--color-surface-raised-foreground": "#0f172a",
    "--color-surface-sunken": "#f1f5f9",
    "--color-surface-sunken-foreground": "#0f172a",
    "--color-surface-hover": "#f1f5f9",
    "--color-surface-active": "#e0f2fe",
    "--color-card": "#ffffff",
    "--color-card-foreground": "#0f172a",
    "--color-card-border": "#e2e8f0",
    "--color-card-hover": "#f8fafc",
    "--color-card-elevated": "#ffffff",
    "--color-input": "#ffffff",
    "--color-input-foreground": "#0f172a",
    "--color-input-border": "#64748b",
    "--color-input-focus-border": "rgba(2, 132, 199, 0.65)",
    "--color-muted": "#f1f5f9",
    "--color-muted-foreground": "#475569",
    "--color-tag": "#f1f5f9",
    "--color-tag-foreground": "#334155",
    "--color-text-primary": "#0f172a",
    "--color-text-secondary": "#334155",
    "--color-text-muted": "#475569",
    "--color-text-dim": "#64748b",
    "--color-text-inverse": "#ffffff",
    "--color-border-subtle": "#e2e8f0",
    "--color-border-medium": "#cbd5e1",
    "--color-border-strong": "#94a3b8",
    "--color-border-focus": "#0284c7",
    "--color-overlay": "rgba(15, 23, 42, 0.5)",
    "--color-primary": "#047857",
    "--color-primary-alpha": "rgba(79, 70, 229, 0.12)",
    "--color-primary-foreground": "#ffffff",
    "--color-accent": "#0369a1",
    "--color-accent-contrast": "#ffffff",
    "--color-accent-subtle": "rgba(3, 105, 161, 0.12)",
    "--color-success": "#15803d",
    "--color-success-foreground": "#ffffff",
    "--color-success-subtle": "rgba(21, 128, 61, 0.12)",
    "--color-primary-hover": "#166534",
    "--color-success-hover": "#166534",
    "--color-danger": "#dc2626",
    "--color-danger-foreground": "#ffffff",
    "--color-danger-subtle": "rgba(220, 38, 38, 0.12)",
    "--color-warning": "#b45309",
    "--color-warning-foreground": "#ffffff",
    "--color-warning-subtle": "rgba(180, 83, 9, 0.12)",
    "--color-info": "#0369a1",
    "--color-info-foreground": "#ffffff",
    "--color-info-subtle": "rgba(3, 105, 161, 0.12)",
    "--color-primary-border": "rgba(79, 70, 229, 0.4)",
    "--color-purple-subtle": "rgba(124, 58, 237, 0.1)",
    "--color-purple-border": "rgba(124, 58, 237, 0.4)",
    "--color-accent-border": "rgba(2, 132, 199, 0.4)",
    "--color-success-border": "rgba(22, 163, 74, 0.4)",
    "--color-danger-border": "rgba(220, 38, 38, 0.4)",
    "--color-warning-border": "rgba(217, 119, 6, 0.45)",
    "--color-trade-subtle": "rgba(194, 65, 12, 0.1)",
    "--color-trade": "#9a3412",
    "--color-trade-deep": "#9a3412",
    "--color-on-gradient": "#ffffff",
    "--color-success-text": "#166534",
    "--color-danger-text": "#b91c1c",
    "--color-warning-text": "#92400e",
    "--color-indigo-text": "#4338ca",
    "--color-purple-text": "#7e22ce",
    "--color-info-text": "#0369a1",
    "--color-purple": "#7c3aed",
    "--color-purple-foreground": "#ffffff",
    "--color-orange": "#ea580c",
    "--color-sentiment-all": "#0284c7",
    "--color-sentiment-all-subtle": "rgba(2, 132, 199, 0.12)",
    "--color-sentiment-all-border": "rgba(2, 132, 199, 0.35)",
    "--color-sentiment-very-bearish": "#dc2626",
    "--color-sentiment-very-bearish-subtle": "rgba(220, 38, 38, 0.12)",
    "--color-sentiment-very-bearish-border": "rgba(220, 38, 38, 0.35)",
    "--color-sentiment-bearish": "#e11d48",
    "--color-sentiment-bearish-subtle": "rgba(225, 29, 72, 0.1)",
    "--color-sentiment-bearish-border": "rgba(225, 29, 72, 0.35)",
    "--color-sentiment-neutral": "#475569",
    "--color-sentiment-neutral-subtle": "rgba(71, 85, 105, 0.1)",
    "--color-sentiment-neutral-border": "rgba(71, 85, 105, 0.3)",
    "--color-sentiment-directional": "#7e22ce",
    "--color-sentiment-directional-subtle": "rgba(126, 34, 206, 0.1)",
    "--color-sentiment-directional-border": "rgba(126, 34, 206, 0.35)",
    "--color-sentiment-bullish": "#16a34a",
    "--color-sentiment-bullish-subtle": "rgba(22, 163, 74, 0.1)",
    "--color-sentiment-bullish-border": "rgba(22, 163, 74, 0.35)",
    "--color-sentiment-very-bullish": "#059669",
    "--color-sentiment-very-bullish-subtle": "rgba(5, 150, 105, 0.12)",
    "--color-sentiment-very-bullish-border": "rgba(5, 150, 105, 0.35)",
    "--color-bullish": "var(--color-sentiment-bullish)",
    "--color-bearish": "var(--color-sentiment-bearish)",
    "--color-gain": "#15803d",
    "--color-gain-foreground": "#ffffff",
    "--color-gain-subtle": "rgba(21, 128, 61, 0.09)",
    "--color-gain-border": "rgba(21, 128, 61, 0.22)",
    "--color-loss": "#dc2626",
    "--color-loss-foreground": "#ffffff",
    "--color-loss-subtle": "rgba(220, 38, 38, 0.09)",
    "--color-loss-border": "rgba(220, 38, 38, 0.22)",
    "--color-surface-glass": "rgba(255, 255, 255, 0.88)",
    "--color-surface-glass-border": "rgba(0, 0, 0, 0.08)",
    "--color-night": "#0b1120",
    "--color-night-border": "rgba(255, 255, 255, 0.1)"
  },
  "high-contrast": {
    "--color-surface": "#000000",
    "--color-surface-foreground": "#ffffff",
    "--color-surface-raised": "#0d0d0d",
    "--color-surface-raised-foreground": "#ffffff",
    "--color-surface-sunken": "#000000",
    "--color-surface-sunken-foreground": "#ffffff",
    "--color-surface-hover": "rgba(255, 255, 255, 0.14)",
    "--color-surface-active": "rgba(0, 208, 255, 0.3)",
    "--color-card": "#0a0a0a",
    "--color-card-foreground": "#ffffff",
    "--color-card-border": "rgba(255, 255, 255, 0.45)",
    "--color-card-hover": "rgba(255, 255, 255, 0.1)",
    "--color-card-elevated": "#171717",
    "--color-input": "#000000",
    "--color-input-foreground": "#ffffff",
    "--color-input-border": "rgba(255, 255, 255, 0.6)",
    "--color-input-focus-border": "#ffd700",
    "--color-muted": "rgba(255, 255, 255, 0.14)",
    "--color-muted-foreground": "#d6d6d6",
    "--color-tag": "rgba(255, 255, 255, 0.16)",
    "--color-tag-foreground": "#ffffff",
    "--color-text-primary": "#ffffff",
    "--color-text-secondary": "#e8e8e8",
    "--color-text-muted": "#cccccc",
    "--color-text-dim": "#ababab",
    "--color-text-inverse": "#000000",
    "--color-border-subtle": "rgba(255, 255, 255, 0.4)",
    "--color-border-medium": "rgba(255, 255, 255, 0.65)",
    "--color-border-strong": "#ffffff",
    "--color-border-focus": "#ffd700",
    "--color-overlay": "rgba(0, 0, 0, 0.92)",
    "--color-primary": "#00e065",
    "--color-primary-alpha": "rgba(129, 140, 248, 0.35)",
    "--color-primary-foreground": "#000000",
    "--color-accent": "#00d0ff",
    "--color-accent-contrast": "#000000",
    "--color-accent-subtle": "rgba(0, 208, 255, 0.25)",
    "--color-success": "#00e065",
    "--color-success-foreground": "#000000",
    "--color-success-subtle": "rgba(0, 224, 101, 0.22)",
    "--color-primary-hover": "#00c853",
    "--color-success-hover": "#00c853",
    "--color-danger": "#ff4d4d",
    "--color-danger-foreground": "#000000",
    "--color-danger-subtle": "rgba(255, 77, 77, 0.22)",
    "--color-warning": "#ffd60a",
    "--color-warning-foreground": "#000000",
    "--color-warning-subtle": "rgba(255, 214, 10, 0.2)",
    "--color-info": "#33bbff",
    "--color-info-foreground": "#000000",
    "--color-info-subtle": "rgba(51, 187, 255, 0.22)",
    "--color-primary-border": "rgba(129, 140, 248, 0.65)",
    "--color-purple-subtle": "rgba(215, 109, 255, 0.22)",
    "--color-purple-border": "rgba(215, 109, 255, 0.6)",
    "--color-accent-border": "rgba(0, 208, 255, 0.65)",
    "--color-success-border": "rgba(0, 224, 101, 0.6)",
    "--color-danger-border": "rgba(255, 77, 77, 0.6)",
    "--color-warning-border": "rgba(255, 214, 10, 0.55)",
    "--color-trade-subtle": "rgba(255, 145, 0, 0.22)",
    "--color-trade": "#ff9100",
    "--color-trade-deep": "#ff6d00",
    "--color-on-gradient": "#000000",
    "--color-success-text": "#4dff88",
    "--color-danger-text": "#ff8a80",
    "--color-warning-text": "#ffd60a",
    "--color-indigo-text": "#b3c0ff",
    "--color-purple-text": "#e39dff",
    "--color-info-text": "#66ccff",
    "--color-purple": "#d76dff",
    "--color-purple-foreground": "#000000",
    "--color-orange": "#ff9100",
    "--color-sentiment-all": "#00d0ff",
    "--color-sentiment-all-subtle": "rgba(0, 208, 255, 0.22)",
    "--color-sentiment-all-border": "rgba(0, 208, 255, 0.6)",
    "--color-sentiment-very-bearish": "#ff4d4d",
    "--color-sentiment-very-bearish-subtle": "rgba(255, 77, 77, 0.24)",
    "--color-sentiment-very-bearish-border": "rgba(255, 77, 77, 0.6)",
    "--color-sentiment-bearish": "#ff8a80",
    "--color-sentiment-bearish-subtle": "rgba(255, 138, 128, 0.22)",
    "--color-sentiment-bearish-border": "rgba(255, 138, 128, 0.55)",
    "--color-sentiment-neutral": "#e8e8e8",
    "--color-sentiment-neutral-subtle": "rgba(255, 255, 255, 0.18)",
    "--color-sentiment-neutral-border": "rgba(255, 255, 255, 0.5)",
    "--color-sentiment-directional": "#e39dff",
    "--color-sentiment-directional-subtle": "rgba(215, 109, 255, 0.22)",
    "--color-sentiment-directional-border": "rgba(215, 109, 255, 0.55)",
    "--color-sentiment-bullish": "#4dff88",
    "--color-sentiment-bullish-subtle": "rgba(0, 224, 101, 0.22)",
    "--color-sentiment-bullish-border": "rgba(0, 224, 101, 0.55)",
    "--color-sentiment-very-bullish": "#00e065",
    "--color-sentiment-very-bullish-subtle": "rgba(0, 224, 101, 0.26)",
    "--color-sentiment-very-bullish-border": "rgba(0, 224, 101, 0.6)",
    "--color-bullish": "var(--color-sentiment-bullish)",
    "--color-bearish": "var(--color-sentiment-bearish)",
    "--color-gain": "#00e065",
    "--color-gain-foreground": "#000000",
    "--color-gain-subtle": "rgba(0, 224, 101, 0.22)",
    "--color-gain-border": "rgba(0, 224, 101, 0.6)",
    "--color-loss": "#ff4d4d",
    "--color-loss-foreground": "#000000",
    "--color-loss-subtle": "rgba(255, 77, 77, 0.22)",
    "--color-loss-border": "rgba(255, 77, 77, 0.6)",
    "--color-surface-glass": "#0a0a0a",
    "--color-surface-glass-border": "rgba(255, 255, 255, 0.45)",
    "--color-night": "#000000",
    "--color-night-border": "rgba(255, 255, 255, 0.5)"
  }
};
/* END GENERATED TOKENS */

/**
 * Ad accent palette (#476): user-selectable DATA values for sponsored-card
 * accents — content choices, not theme styling. They live in the token
 * module so raw color values stay confined to token sources.
 */
export const adAccentPalette = [
  { value: "#6366f1", label: "Indigo" },
  { value: "#f38020", label: "Amber Orange" },
  { value: "#06b6d4", label: "Cyan" },
  { value: "#10b981", label: "Emerald Green" },
  { value: "#a855f7", label: "Purple" },
  { value: "#f43f5e", label: "Rose" },
] as const;

/**
 * Issue 6406 — fallback colors for the hunt chart's canvas (lightweight-charts
 * needs concrete colors; canvas does not resolve var()). Used only when the
 * theme token cannot be resolved (non-browser / test environments); in the
 * app the live token value wins. They live in the token module so raw color
 * values stay confined to token sources.
 */
export const chartColorFallbacks = {
  "--color-border-subtle": "#e5e5e5",
  "--color-text-muted": "#888888",
  "--color-accent": "#2962ff",
  "--color-success": "#26a69a",
  "--color-danger": "#ef5350",
  "--color-warning": "#ff9800",
} as const;

export type ChartColorToken = keyof typeof chartColorFallbacks;
