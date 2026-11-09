import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { checkClientBundle } from "../scripts/qa-smoke.mjs";

/**
 * Issue #3891 — production served a stale client bundle while the deploy
 * reported success: the 13084a0 deploy built index-C4wpUEeO.js, but the
 * live asset layer still served the aa751785-era index-CrmpFmqc.js and the
 * new asset 404'd. qa-smoke only asserted /api/health 200, so the failure
 * was silent.
 *
 * The fix: the build embeds its short commit sha in the bundle
 * (__BUILD_COMMIT__), the deploy job hands qa-smoke the built asset path +
 * commit, and qa-smoke asserts the live asset 200s and contains the marker
 * — retrying briefly for propagation, then FAILING the job instead of
 * reporting success.
 */

function stubFetch(responses: Array<{ status: number; body: string }>) {
  let calls = 0;
  const fetchFn = vi.fn(async (_url: string) => {
    const r = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    return { status: r.status, text: async () => r.body };
  });
  return { fetchFn, calls: () => calls };
}

describe("checkClientBundle (#3891)", () => {
  it("passes on first attempt when the live asset 200s with the commit marker", async () => {
    const { fetchFn } = stubFetch([
      { status: 200, body: "…window.__BUILD_COMMIT__=\"13084a08\"…" },
    ]);
    const result = await checkClientBundle({
      fetchFn,
      baseUrl: "https://agent.openaimp.com",
      expectedAsset: "/assets/index-C4wpUEeO.js",
      expectedCommit: "13084a08",
      maxAttempts: 3,
      delayMs: 0,
      sleepFn: async () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://agent.openaimp.com/assets/index-C4wpUEeO.js",
    );
  });

  it("retries a 404 and passes when the asset appears (propagation grace)", async () => {
    const { fetchFn, calls } = stubFetch([
      { status: 404, body: "Not Found" },
      { status: 200, body: "…__BUILD_COMMIT__=\"13084a08\"…" },
    ]);
    const result = await checkClientBundle({
      fetchFn,
      baseUrl: "https://agent.openaimp.com",
      expectedAsset: "/assets/index-C4wpUEeO.js",
      expectedCommit: "13084a08",
      maxAttempts: 3,
      delayMs: 0,
      sleepFn: async () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(calls()).toBe(2);
  });

  it("fails when the live asset 200s but carries an older commit marker (stale deploy)", async () => {
    const { fetchFn } = stubFetch([
      { status: 200, body: "…__BUILD_COMMIT__=\"aa751785\"…" },
    ]);
    const result = await checkClientBundle({
      fetchFn,
      baseUrl: "https://agent.openaimp.com",
      expectedAsset: "/assets/index-C4wpUEeO.js",
      expectedCommit: "13084a08",
      maxAttempts: 2,
      delayMs: 0,
      sleepFn: async () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.detail).toContain("aa751785");
  });

  it("fails after exhausting attempts when the asset keeps 404ing (the #3891 symptom)", async () => {
    const { fetchFn } = stubFetch([{ status: 404, body: "Not Found" }]);
    const result = await checkClientBundle({
      fetchFn,
      baseUrl: "https://agent.openaimp.com",
      expectedAsset: "/assets/index-C4wpUEeO.js",
      expectedCommit: "13084a08",
      maxAttempts: 2,
      delayMs: 0,
      sleepFn: async () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.detail).toContain("404");
  });
});

describe("client-bundle marker wiring (#3891)", () => {
  it("vite build embeds the short commit sha as __BUILD_COMMIT__", () => {
    const config = readFileSync("vite.config.ts", "utf8");
    expect(config).toContain("__BUILD_COMMIT__");
    expect(config).toContain("GITHUB_SHA");
  });

  it("main.tsx exposes the marker on window so it survives in the bundle", () => {
    const main = readFileSync("src/client/main.tsx", "utf8");
    expect(main).toContain("__BUILD_COMMIT__");
  });

  it("qa-smoke reads the expected asset + commit from the deploy job and asserts the live bundle", () => {
    const smoke = readFileSync("scripts/qa-smoke.mjs", "utf8");
    expect(smoke).toContain("EXPECTED_CLIENT_ASSET");
    expect(smoke).toContain("EXPECTED_COMMIT");
    expect(smoke).toContain("checkClientBundle");
    expect(smoke).toContain("deployed client bundle");
  });
});
