/**
 * Issue #5182 — one notice per (run, rendered text) within a short window.
 * The 23:35Z duplicate carried one timestamp: the same payload delivered twice,
 * not two runs.
 */
import { describe, expect, it } from "vitest";
import { claimNoticeDelivery } from "../src/services/optionsRunAlertFormat";

describe("claimNoticeDelivery (#5182)", () => {
  it("lets the first notice through and suppresses the identical second", () => {
    const key = `run_a|text`;

    expect(claimNoticeDelivery(key, 1_000)).toBe(true);
    expect(claimNoticeDelivery(key, 1_001)).toBe(false);
  });

  it("never collides two different runs", () => {
    expect(claimNoticeDelivery("run_b|text", 2_000)).toBe(true);
    expect(claimNoticeDelivery("run_c|text", 2_001)).toBe(true);
  });

  it("re-delivers after the window, so a later retry is not silenced forever", () => {
    const key = "run_d|text";

    expect(claimNoticeDelivery(key, 3_000)).toBe(true);
    expect(claimNoticeDelivery(key, 3_000 + 300_001)).toBe(true);
  });
});
