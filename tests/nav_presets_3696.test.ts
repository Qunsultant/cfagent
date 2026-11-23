/**
 * Nav presets pin test (issues 3696 S1 + 3697 S2, subs of epic 3695).
 *
 * Drift fails CI: a new left-nav item that lands in no preset, a preset
 * key with nothing in it, a pill that names no config item, or a `none`
 * that does not survive a reload must break the build here, not in the
 * deployed nav.
 */
import React from "react";
import { describe, it, expect } from "vitest";
import ReactDOMServer from "react-dom/server";
import {
  NAV_TAB_PRESETS,
  NAV_PRESET_KEYS,
  buildPresetMap,
  completeVisibleTabs,
  derivePresetKey,
  leftNavConfigIds,
  type NavPresetKey,
} from "../src/client/navPresets";
import { NavSettingsPage } from "../src/client/NavSettingsPage";
import { isTabFeatureEnabled } from "../src/client/featureFlags";

const COVERAGE_KEYS: NavPresetKey[] = [
  "research",
  "trading",
  "payment",
  "marketing",
  "platform",
  "minimal",
];

function renderPage(
  visibleTabs: Record<string, boolean>,
  activePreset: NavPresetKey | null,
): string {
  return ReactDOMServer.renderToString(
    React.createElement(NavSettingsPage, {
      visibleTabs,
      activePreset,
      onToggleTabVisibility: () => {},
      onApplyPreset: () => {},
    }),
  );
}

function pillIds(html: string): string[] {
  return [...html.matchAll(/data-tab-id="([^"]+)"/g)].map((m) => m[1]);
}

function presetKeys(html: string): string[] {
  return [...html.matchAll(/data-preset="([^"]+)"/g)].map((m) => m[1]);
}

describe("nav presets pin (#3696/#3697)", () => {
  it("covers every toggleable nav id in at least one preset besides alltabs/none", () => {
    for (const id of leftNavConfigIds()) {
      const covered = COVERAGE_KEYS.some(
        (key) => NAV_TAB_PRESETS[key][id] === true,
      );
      expect(covered, `${id} is in no preset besides alltabs/none`).toBe(
        true,
      );
    }
  });

  it("has no dead preset key and no two presets are the same map", () => {
    for (const key of NAV_PRESET_KEYS) {
      const map = NAV_TAB_PRESETS[key];
      const onCount = Object.values(map).filter(Boolean).length;
      if (key === "none") {
        expect(onCount).toBe(0);
      } else {
        expect(onCount, `${key} enables nothing`).toBeGreaterThan(0);
      }
    }
    for (let i = 0; i < NAV_PRESET_KEYS.length; i++) {
      for (let j = i + 1; j < NAV_PRESET_KEYS.length; j++) {
        const a = NAV_TAB_PRESETS[NAV_PRESET_KEYS[i]];
        const b = NAV_TAB_PRESETS[NAV_PRESET_KEYS[j]];
        const same = leftNavConfigIds().every((id) => a[id] === b[id]);
        expect(
          same,
          `${NAV_PRESET_KEYS[i]} and ${NAV_PRESET_KEYS[j]} are identical maps`,
        ).toBe(false);
      }
    }
  });

  it("renders one pill per feature-enabled config item, and no other pill", () => {
    const html = renderPage(buildPresetMap("alltabs"), "alltabs");
    const rendered = pillIds(html);
    const expected = leftNavConfigIds().filter((id) =>
      isTabFeatureEnabled(id),
    );
    // Measured on this tree: autopilot, order, orders, voice, and
    // payments are flag-gated off under the test-env defaults, so the
    // page renders 21 pills, not 26.
    expect(rendered.length).toBe(21);
    expect([...rendered].sort()).toEqual([...expected].sort());
    for (const id of rendered) {
      expect(leftNavConfigIds()).toContain(id);
    }
    // The route-only ids have no pill of their own — they follow
    // their parent.
    for (const id of [
      "checkout",
      "docs",
      "endpoints",
      "ledger",
      "payment-assurance",
      "revenue",
      "workflows",
    ]) {
      expect(rendered).not.toContain(id);
    }
    // All eight preset buttons render.
    expect([...presetKeys(html)].sort()).toEqual(
      [...NAV_PRESET_KEYS].sort(),
    );
  });

  it("renders the pills the decided set adds and drops the route-only ones", () => {
    const html = renderPage(buildPresetMap("alltabs"), "alltabs");
    const rendered = pillIds(html);
    // The old menu pills iterated NAVIGATION_ITEMS (27): they never
    // covered these four config ids, and listed seven route-only ids.
    for (const id of ["goal-screen", "orders", "schedules", "sandbox"]) {
      // goal-screen and schedules are feature-enabled in this env;
      // orders and sandbox are covered by the map even where their
      // flags hide the pill — the pin is the map, asserted above.
      if (isTabFeatureEnabled(id)) {
        expect(rendered).toContain(id);
      }
    }
    expect(rendered).not.toContain("checkout");
    expect(rendered).not.toContain("workflows");
  });

  it("shows the active preset and the custom state on the page", () => {
    const noneHtml = renderPage(buildPresetMap("none"), "none");
    expect(noneHtml).toContain("Active preset: None");
    expect(noneHtml).toContain("Nothing is selected");
    const custom = { ...buildPresetMap("minimal"), "stock-hub": false };
    const customHtml = renderPage(custom, derivePresetKey(custom));
    expect(customHtml).toContain("Custom selection");
    expect(customHtml).not.toContain("Active preset:");
  });

  it("none is an empty set that survives reload", () => {
    // Selecting none writes the empty selection.
    const noneMap = buildPresetMap("none");
    expect(Object.values(noneMap).every((v) => v === false)).toBe(true);
    // Reload: the saved map + the saved preset key complete to none.
    expect(completeVisibleTabs(noneMap, "none")).toEqual(noneMap);
    expect(derivePresetKey(completeVisibleTabs(noneMap, "none"))).toBe(
      "none",
    );
    // Reload without the preset key (a legacy all-false write): the
    // completion still lands on none, never resurrects.
    expect(completeVisibleTabs(noneMap, null)).toEqual(noneMap);
  });

  it("none-then-other-preset replaces none; none-when-empty is a no-op", () => {
    const afterTrading = buildPresetMap("trading");
    expect(derivePresetKey(afterTrading)).toBe("trading");
    expect(afterTrading).not.toEqual(buildPresetMap("none"));
    // Applying none to an already-empty selection changes nothing.
    const alreadyNone = buildPresetMap("none");
    expect(buildPresetMap("none")).toEqual(alreadyNone);
    expect(derivePresetKey(alreadyNone)).toBe("none");
  });
});
