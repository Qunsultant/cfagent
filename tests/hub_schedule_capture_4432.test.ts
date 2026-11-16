/**
 * Issue #4432 (S4c): the Stock Hub "Schedule this screen" capture.
 *
 * Pins for buildMarketScreenCaptureSubmission — the one builder-module
 * path for the hub capture (mirrors the S8 discovery-capture golden in
 * tests/screening_hub_s8.test.tsx):
 *  - a hub capture builds a marketScreen create body (callback,
 *    scheduleType + cadence key, payload universe/sector/maxItems/
 *    filters/delivery, trigger "scheduled")
 *  - an armed preset rides as presetId INSTEAD of frozen filters (#1499)
 *  - no preset + empty filters sends neither key
 *  - universe ALL / missing universe fail loudly with the route's rule
 *  - a non-schema filter key (minScore) fails loudly — the caller must
 *    strip it; the builder never silently drops a field
 *  - maxItems range + cadence variants + one-shot date error
 *  - delivery conventions: slackChannel only when push is on, blank
 *    recipients omitted, values trimmed
 */
import { describe, it, expect } from "vitest";
import { buildMarketScreenCaptureSubmission } from "../src/client/scheduledOptionsManager/payloadBuilders";

const base = {
  universe: "NASDAQ100",
  sector: "Technology",
  maxItems: 100,
  filters: { minRsi: 30, maxRsi: 70 },
  pushToSlack: true,
  slackChannel: "#trading-desk",
  emailTo: "trader@firm.com",
  webhookUrl: "",
  scheduleType: "interval" as const,
  intervalSeconds: 3600,
};

describe("buildMarketScreenCaptureSubmission (#4432)", () => {
  it("builds a marketScreen create body from a hub capture", () => {
    const built = buildMarketScreenCaptureSubmission(base);
    expect(built).toEqual({
      requestBody: {
        callback: "autonomousMarketScreen",
        scheduleType: "interval",
        intervalSeconds: 3600,
        payload: {
          universe: "NASDAQ100",
          sector: "Technology",
          maxItems: 100,
          trigger: "scheduled",
          pushToSlack: true,
          slackChannel: "#trading-desk",
          emailTo: "trader@firm.com",
          filters: { minRsi: 30, maxRsi: 70 },
        },
      },
    });
  });

  it("an armed preset rides as presetId instead of frozen filters", () => {
    const built = buildMarketScreenCaptureSubmission({
      ...base,
      presetId: "p1",
      filters: { minRsi: 30, maxRsi: 70 },
    });
    expect("error" in built).toBe(false);
    if ("error" in built) return;
    expect(built.requestBody.payload.presetId).toBe("p1");
    expect(built.requestBody.payload).not.toHaveProperty("filters");
  });

  it("no preset and empty filters sends neither key", () => {
    const built = buildMarketScreenCaptureSubmission({
      ...base,
      filters: {},
    });
    expect("error" in built).toBe(false);
    if ("error" in built) return;
    expect(built.requestBody.payload).not.toHaveProperty("filters");
    expect(built.requestBody.payload).not.toHaveProperty("presetId");
  });

  it("universe ALL fails loudly", () => {
    expect(buildMarketScreenCaptureSubmission({ ...base, universe: "ALL" })).toEqual({
      error:
        "Scheduled screens need one specific universe — pick a universe other than All before scheduling.",
    });
  });

  it("a missing universe fails loudly", () => {
    expect(buildMarketScreenCaptureSubmission({ ...base, universe: "" })).toEqual({
      error: "Stock schedules require one explicit universe.",
    });
  });

  it("a non-schema filter key (minScore) fails loudly — the caller must strip it", () => {
    const built = buildMarketScreenCaptureSubmission({
      ...base,
      filters: { minRsi: 30, minScore: 50 },
    });
    expect("error" in built).toBe(true);
    if (!("error" in built)) return;
    expect(built.error).toMatch(/minScore/);
  });

  it("maxItems outside 0..10000 fails loudly", () => {
    expect(buildMarketScreenCaptureSubmission({ ...base, maxItems: 10001 })).toEqual({
      error: "maxItems must be a whole number from 0 to 10000.",
    });
    expect(buildMarketScreenCaptureSubmission({ ...base, maxItems: 10.5 })).toEqual({
      error: "maxItems must be a whole number from 0 to 10000.",
    });
  });

  it("omitted maxItems leaves the server to stamp the universe default", () => {
    const { maxItems: _omitted, ...noMax } = base;
    const built = buildMarketScreenCaptureSubmission(noMax);
    expect("error" in built).toBe(false);
    if ("error" in built) return;
    expect(built.requestBody.payload).not.toHaveProperty("maxItems");
  });

  it("cron, delayed, and scheduled cadences apply their keys", () => {
    const cron = buildMarketScreenCaptureSubmission({
      ...base,
      scheduleType: "cron",
      cronExpression: "30 14 * * 1-5",
    });
    expect(cron).toEqual({
      requestBody: expect.objectContaining({
        scheduleType: "cron",
        cron: "30 14 * * 1-5",
      }),
    });
    const delayed = buildMarketScreenCaptureSubmission({
      ...base,
      scheduleType: "delayed",
      delaySeconds: 900,
    });
    expect(delayed).toEqual({
      requestBody: expect.objectContaining({
        scheduleType: "delayed",
        delayInSeconds: 900,
      }),
    });
    const scheduled = buildMarketScreenCaptureSubmission({
      ...base,
      scheduleType: "scheduled",
      scheduledDate: "2026-11-20T14:30",
    });
    expect("error" in scheduled).toBe(false);
    if ("error" in scheduled) return;
    expect(scheduled.requestBody.date).toBe(
      new Date("2026-11-20T14:30").toISOString(),
    );
  });

  it("a one-shot date is required for the scheduled cadence", () => {
    expect(
      buildMarketScreenCaptureSubmission({ ...base, scheduleType: "scheduled" }),
    ).toEqual({ error: "Pick a date and time for the one-shot run." });
  });

  it("delivery follows the form conventions: slackChannel only when push is on, blanks omitted, values trimmed", () => {
    const built = buildMarketScreenCaptureSubmission({
      ...base,
      pushToSlack: false,
      slackChannel: "#trading-desk",
      emailTo: "  trader@firm.com  ",
      webhookUrl: " https://example.com/hook ",
    });
    expect("error" in built).toBe(false);
    if ("error" in built) return;
    expect(built.requestBody.payload.pushToSlack).toBe(false);
    // slackChannel rides the payload key with an undefined value when
    // push is off (the form branch's convention — JSON drops it on the
    // wire), so assert the value, not the key's absence.
    expect(built.requestBody.payload.slackChannel).toBeUndefined();
    expect(built.requestBody.payload.emailTo).toBe("trader@firm.com");
    expect(built.requestBody.payload.webhookUrl).toBe("https://example.com/hook");
  });
});
