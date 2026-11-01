import { describe, it, expect } from "vitest";
import {
  DEFAULT_LEFT_NAV_CONFIG,
  findNavItemConfig,
  sandboxNavHrefFromNavId,
  SANDBOX_NAV_ID,
} from "../src/client/navConfig";

describe("left nav Sandbox section (issue #2645)", () => {
  it("exposes a SANDBOX section with a Checkout sandbox item", () => {
    const section = DEFAULT_LEFT_NAV_CONFIG.sections.find(
      (s) => s.id === "section-sandbox"
    );
    expect(section).toBeDefined();
    expect(section!.title).toBe("SANDBOX");
    expect(section!.items).toHaveLength(1);
    const item = findNavItemConfig(DEFAULT_LEFT_NAV_CONFIG, SANDBOX_NAV_ID);
    expect(item).toBeDefined();
    expect(item!.label).toBe("Checkout sandbox");
  });

  it("maps the sandbox nav id to /checkout/sandbox and nothing else", () => {
    expect(sandboxNavHrefFromNavId(SANDBOX_NAV_ID)).toBe("/checkout/sandbox");
    expect(sandboxNavHrefFromNavId("autopilot")).toBeUndefined();
    expect(sandboxNavHrefFromNavId("platform-admin")).toBeUndefined();
    expect(sandboxNavHrefFromNavId("")).toBeUndefined();
  });
});
