// @vitest-environment node
/**
 * #6151 S1 — the selection ∩ availability merge
 * (src/client/platformContextNav.ts).
 *
 * Chat.tsx keeps the user's SELECTION (the adopted localStorage map,
 * or the persona default for a fresh user); the context store carries
 * the server-computed AVAILABILITY. The effective map passed down to
 * NavigationMenu / LeftNavBar / NavSettingsPage is the intersection:
 *
 * - top-level id: visible iff selected AND available;
 * - sub-item key `<parent>:<sub>`: visible iff the PARENT is selected
 *   AND the sub-item is available (sub-items follow their parent
 *   until #6147 S6 adds per-sub-item toggles);
 * - the effective map covers exactly the availability keys — a stale
 *   selection id the server no longer enumerates is dropped, never
 *   resurrected.
 */
import { describe, expect, it } from "vitest";
import { mergeVisibleTabs } from "../src/client/platformContextNav";

describe("mergeVisibleTabs (#6151 S1)", () => {
  it("intersects selection and availability on top-level ids", () => {
    expect(
      mergeVisibleTabs(
        { chat: true, order: false, portfolio: true },
        { chat: true, order: true, portfolio: false },
      ),
    ).toEqual({ chat: true, order: false, portfolio: false });
  });

  it("a sub-item follows its parent's selection and its own availability", () => {
    expect(
      mergeVisibleTabs(
        { "data-hub": true, orders: false },
        {
          "data-hub": true,
          "data-hub:data-providers": true,
          "data-hub:feeds": false,
          orders: true,
          "orders:history": true,
        },
      ),
    ).toEqual({
      "data-hub": true,
      "data-hub:data-providers": true,
      "data-hub:feeds": false,
      orders: false,
      "orders:history": false,
    });
  });

  it("drops selection ids the server no longer enumerates", () => {
    expect(
      mergeVisibleTabs(
        { chat: true, "retired-tab": true },
        { chat: true },
      ),
    ).toEqual({ chat: true });
  });

  it("an unselected top-level id hides its sub-items even when available", () => {
    expect(
      mergeVisibleTabs(
        { "data-hub": false },
        { "data-hub": true, "data-hub:data-providers": true },
      ),
    ).toEqual({ "data-hub": false, "data-hub:data-providers": false });
  });
});
