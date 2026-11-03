/**
 * Issue #2981 (monetization Phase 2.18) — digest content provider.
 *
 * Unit tests for src/services/digestContentProvider.ts:
 * - window: reports since the previous UTC day start, boundary included;
 * - order: newest first;
 * - line format: title + summary, summary truncated at 280 chars;
 * - provider: tenantId passed through to the reader, null reader → [],
 *   reader throw propagates (the pass records items-failed).
 */
import { describe, expect, it, vi } from "vitest";
import {
  DIGEST_HIGHLIGHT_SUMMARY_MAX,
  buildDigestHighlights,
  createDigestContentProvider,
  digestWindowStartMs,
  formatDigestHighlight,
  type DigestHighlightRow,
} from "../src/services/digestContentProvider";

const NOW = Date.parse("2026-11-04T09:30:00Z");
const WINDOW_START = Date.parse("2026-11-03T00:00:00Z");
const HOUR = 3600_000;

function row(over: Partial<DigestHighlightRow> = {}): DigestHighlightRow {
  return {
    title: "Screener run",
    summary: "AAPL, MSFT flagged",
    createdAtMs: NOW - HOUR,
    ...over,
  };
}

describe("digestWindowStartMs (#2981)", () => {
  it("is the previous UTC day at 00:00", () => {
    expect(digestWindowStartMs(NOW)).toBe(WINDOW_START);
  });

  it("is stable across the day boundary (early-morning pass)", () => {
    expect(digestWindowStartMs(Date.parse("2026-11-04T00:05:00Z"))).toBe(
      WINDOW_START,
    );
  });
});

describe("buildDigestHighlights (#2981)", () => {
  it("includes reports at the window start, excludes older ones", () => {
    const items = buildDigestHighlights(
      [
        row({ title: "at-start", createdAtMs: WINDOW_START }),
        row({ title: "before", createdAtMs: WINDOW_START - 1 }),
        row({ title: "recent", createdAtMs: NOW - HOUR }),
      ],
      NOW,
    );
    expect(items).toHaveLength(2);
    expect(items.join("\n")).toContain("at-start");
    expect(items.join("\n")).toContain("recent");
    expect(items.join("\n")).not.toContain("before");
  });

  it("orders newest first", () => {
    const items = buildDigestHighlights(
      [
        row({ title: "older", createdAtMs: NOW - 5 * HOUR }),
        row({ title: "newer", createdAtMs: NOW - HOUR }),
      ],
      NOW,
    );
    expect(items[0]).toContain("newer");
    expect(items[1]).toContain("older");
  });

  it("formats one line per report: title + summary", () => {
    expect(buildDigestHighlights([row()], NOW)).toEqual([
      "Screener run: AAPL, MSFT flagged",
    ]);
  });

  it("omits the separator when the summary is empty", () => {
    expect(buildDigestHighlights([row({ summary: "" })], NOW)).toEqual([
      "Screener run",
    ]);
  });

  it("truncates long summaries at the stated cap with an ellipsis", () => {
    const long = "x".repeat(DIGEST_HIGHLIGHT_SUMMARY_MAX + 50);
    const line = formatDigestHighlight(row({ summary: long }));
    expect(line).toBe(`Screener run: ${"x".repeat(DIGEST_HIGHLIGHT_SUMMARY_MAX)}…`);
  });

  it("returns [] for no windowed reports (skip-on-empty input)", () => {
    expect(buildDigestHighlights([row({ createdAtMs: NOW - 72 * HOUR })], NOW)).toEqual([]);
    expect(buildDigestHighlights([], NOW)).toEqual([]);
  });
});

describe("createDigestContentProvider (#2981)", () => {
  it("passes the subscriber tenantId to the reader, never the userId", async () => {
    const reader = vi.fn(async (tenantId: string) => [row()]);
    const provider = createDigestContentProvider(reader, () => NOW);
    const items = await provider("user-1", "tenant-9");
    expect(reader).toHaveBeenCalledWith("tenant-9");
    expect(reader).not.toHaveBeenCalledWith("user-1");
    expect(items).toEqual(["Screener run: AAPL, MSFT flagged"]);
  });

  it("returns [] when the reader returns null (store unbound)", async () => {
    const provider = createDigestContentProvider(async () => null, () => NOW);
    await expect(provider("u1", "t1")).resolves.toEqual([]);
  });

  it("lets reader failures propagate (pass records items-failed)", async () => {
    const provider = createDigestContentProvider(async () => {
      throw new Error("boom");
    }, () => NOW);
    await expect(provider("u1", "t1")).rejects.toThrow("boom");
  });
});
