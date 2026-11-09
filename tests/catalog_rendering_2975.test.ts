/**
 * Issue #2975 (Phase 5 Slice 9) — catalog-only rendering.
 *
 * Channel templates live in src/outcomes/outcomeCatalog.json under the
 * top-level "channelTemplates" section (NOT as new outcome keys: the
 * #2381 pin requires every outcomes key to match SUCCESS|FAILURE and
 * carry full outcome fields, and notice/alert texts are not outcomes).
 * Each shipped template has a frozen "legacy_*" twin with identical
 * text at ship time (no copy change); the renderer falls back to the
 * twin when the primary template is missing, and never throws or
 * returns blank. Surfaces render from the catalog; the only copy
 * literals that remain on a surface are none — the legacy text lives
 * in the catalog file, which is the point ("alert copy becomes a
 * catalog edit instead of a code edit").
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import catalog from "../src/outcomes/outcomeCatalog.json";
import {
  getOutcome,
  renderChannelText,
  resolveOutcome,
} from "../src/outcomes/outcomeAspects";
import {
  buildJourneyGatePrompt,
  buildSlackJourneyPrompt,
} from "../src/workflows/sagaJourneyGate";
import { buildSagaOutcomeNotice } from "../src/workflows/sagaOutcomeNotice";

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

const CHANNEL_KEYS = [
  "saga_journey_prompt",
  "legacy_saga_journey_prompt",
  "saga_outcome_notice",
  "legacy_saga_outcome_notice",
  "stuck_run_alert",
  "legacy_stuck_run_alert",
  "resource_cap_alert",
  "legacy_resource_cap_alert",
  "resource_cap_breach_line",
  "legacy_resource_cap_breach_line",
  "missed_schedule_alert",
  "legacy_missed_schedule_alert",
];

const JOURNEY_EXPECTED =
  "Enter the trading leg? — run run-1 (goal). This authorizes ENTERING the trading leg for this paid screen. " +
  "It is NOT approval of any trade: each trade will still ask for its own per-order approval before anything is placed. " +
  "Denying, or letting this expire, ends the saga with no trades and no proposals. " +
  "If this screen had failed, a provider refund would be requested first — operator approval is still required before money moves — " +
  "with a replacement-run credit as fallback if a refund cannot be requested.";

const NOTICE_SETTLED_EXPECTED =
  "[SUCCESS_SAGA_TRADE_SETTLED] The trade leg settled; the saga ends with the trade outcome. " +
  "Saga: saga-1. Status: /api/saga/saga-1/status";

const NOTICE_UNKNOWN_EXPECTED =
  "Saga saga-1 ended with outcome FAILURE_SAGA_NOPE (not in the outcome catalog). " +
  "Saga: saga-1. Status: /api/saga/saga-1/status";

const STUCK_EXPECTED =
  "⚠️ Stuck run detected: job job-1 (screen) has been running for ~45 min (alert threshold 30 min; the 2h reap is the backstop).\n" +
  "Capability: screener · Owner: u1 · Started: 2026-11-02T00:00:00Z\n" +
  "Diagnosis + safe intervention: docs/operations/runbook/stuck-runs.md";

const CAP_EXPECTED =
  "⚠️ SessionStore cap alert — 2026-11-02 (UTC, day-to-date)\n" +
  "- rowsRead: 4,000,000 / 5,000,000 (70.0% of cap, 70% alert threshold)\n" +
  "- rowsWritten: 80,000 / 100,000 (80.0% of cap, 70% alert threshold)\n" +
  "Day-to-date totals: rowsRead 4,000,000, rowsWritten 80,000, DO requests (SessionStore ops, lower bound) 75,000.\n" +
  "Scope: SessionStore projection only — a breach here implies the account is at >=70%; " +
  "no breach does not prove account safety (other DO namespaces uncounted). See #1819.";

const MISSED_EXPECTED =
  "⚠️ Missed schedule firing: goal daily-qa-sweep — missed-fire: expected 2026-11-08T06:00:00.000Z (last run: never)\n" +
  "Diagnosis: docs/architecture/security/schedule-watchdog-3788.md";

describe("catalog channel templates (#2975)", () => {
  it("carries every shipped template with a non-empty slack string", () => {
    const templates = (catalog as unknown as Record<string, unknown>)[
      "channelTemplates"
    ] as Record<string, Record<string, unknown>>;
    expect(templates).toBeDefined();
    for (const key of CHANNEL_KEYS) {
      expect(typeof templates[key]?.["slack"]).toBe("string");
      expect((templates[key]["slack"] as string).length).toBeGreaterThan(0);
    }
  });

  it("leaves old entries without channel fields resolving exactly as before", () => {
    const resolved = resolveOutcome("FAILURE_AUTH_NO_SESSION");
    expect(resolved.resolved).toBe(true);
    expect(resolved.businessMessage).toBe(
      "No E*TRADE session is stored for this account. Please connect your account in Settings.",
    );
    expect(
      (getOutcome("FAILURE_AUTH_NO_SESSION") as unknown as Record<string, unknown>)[
        "channels"
      ],
    ).toBeUndefined();
  });

  it("substitutes vars into a template", () => {
    expect(
      renderChannelText(
        "saga_journey_prompt",
        "slack",
        {
          title: "T",
          runRequestId: "r",
          family: "goal",
          body: "B",
          compensationLine: "C",
        },
        "legacy_saga_journey_prompt",
      ),
    ).toBe("T — run r (goal). B C");
  });

  it("falls back to the legacy twin when the primary template is missing", () => {
    expect(
      renderChannelText(
        "nope_missing_key",
        "slack",
        {
          title: "T",
          runRequestId: "r",
          family: "goal",
          body: "B",
          compensationLine: "C",
        },
        "legacy_saga_journey_prompt",
      ),
    ).toBe("T — run r (goal). B C");
  });

  it("never throws and never returns blank when both templates are missing", () => {
    let out: string | undefined;
    expect(() => {
      out = renderChannelText("nope_missing_key", "slack", {});
    }).not.toThrow();
    expect(out).toBeDefined();
    expect((out as string).length).toBeGreaterThan(0);
  });

  it("renders a missing var as empty, never throws", () => {
    expect(() =>
      renderChannelText("saga_journey_prompt", "slack", { title: "T" }),
    ).not.toThrow();
  });
});

describe("migrated surfaces render from the catalog, byte-identical (#2975)", () => {
  it("journey prompt text equals the pre-migration text (stripe rail dump)", () => {
    const prompt = buildJourneyGatePrompt("saga-1", "run-1", "goal", "stripe");
    expect(buildSlackJourneyPrompt(prompt).text).toBe(JOURNEY_EXPECTED);
    expect(
      renderChannelText(
        "saga_journey_prompt",
        "slack",
        {
          title: prompt.copy.title,
          runRequestId: prompt.runRequestId,
          family: prompt.family,
          body: prompt.copy.body,
          compensationLine: prompt.copy.compensationLine,
        },
        "legacy_saga_journey_prompt",
      ),
    ).toBe(JOURNEY_EXPECTED);
  });

  it("outcome notice text equals the pre-migration text (resolved + unknown)", () => {
    const settled = buildSagaOutcomeNotice({
      sagaId: "saga-1",
      runRequestId: "run-1",
      outcomeCode: "SUCCESS_SAGA_TRADE_SETTLED",
      statusUrl: "/api/saga/saga-1/status",
    });
    expect(settled.text).toBe(NOTICE_SETTLED_EXPECTED);
    const unknown = buildSagaOutcomeNotice({
      sagaId: "saga-1",
      runRequestId: "run-1",
      outcomeCode: "FAILURE_SAGA_NOPE",
      statusUrl: "/api/saga/saga-1/status",
    });
    expect(unknown.text).toBe(NOTICE_UNKNOWN_EXPECTED);
  });

  it("stuck-run template renders the legacy alert text for the same inputs", () => {
    expect(
      renderChannelText(
        "stuck_run_alert",
        "slack",
        {
          jobId: "job-1",
          label: "screen",
          ageMin: 45,
          thresholdMin: 30,
          capability: "screener",
          ownerLogin: "u1",
          startedAt: "2026-11-02T00:00:00Z",
        },
        "legacy_stuck_run_alert",
      ),
    ).toBe(STUCK_EXPECTED);
  });

  it("missed-schedule template renders the watchdog alert text (#3788)", () => {
    expect(
      renderChannelText(
        "missed_schedule_alert",
        "slack",
        {
          scheduleId: "daily-qa-sweep",
          kind: "goal",
          expectedTick: "2026-11-08T06:00:00.000Z",
          lastRun: "never",
          detail: "missed-fire: expected 2026-11-08T06:00:00.000Z (last run: never)",
        },
        "legacy_missed_schedule_alert",
      ),
    ).toBe(MISSED_EXPECTED);
  });

  it("cap-alert templates render the legacy cap text for the same inputs", () => {
    const breachLines = [
      renderChannelText(
        "resource_cap_breach_line",
        "slack",
        {
          budget: "rowsRead",
          cumulative: "4,000,000",
          limit: "5,000,000",
          pct: "70.0",
        },
        "legacy_resource_cap_breach_line",
      ),
      renderChannelText(
        "resource_cap_breach_line",
        "slack",
        {
          budget: "rowsWritten",
          cumulative: "80,000",
          limit: "100,000",
          pct: "80.0",
        },
        "legacy_resource_cap_breach_line",
      ),
    ].join("\n");
    expect(
      renderChannelText(
        "resource_cap_alert",
        "slack",
        {
          day: "2026-11-02",
          breachLines,
          rowsRead: "4,000,000",
          rowsWritten: "80,000",
          ops: "75,000",
        },
        "legacy_resource_cap_alert",
      ),
    ).toBe(CAP_EXPECTED);
  });
});

describe("no hand-written variant remains on the four surfaces (#2975)", () => {
  it("orchestrator routes the stuck alert through the renderer, literal gone", () => {
    const text = src("src/agents/orchestrator.ts");
    expect(text).toContain('renderChannelText("stuck_run_alert"');
    expect(text).not.toContain("Stuck run detected");
  });

  it("resourceGoals routes cap alerts through the renderer, literals gone", () => {
    const text = src("src/agents/resourceGoals.ts");
    expect(text).toContain('renderChannelText("resource_cap_alert"');
    expect(text).toContain('renderChannelText("resource_cap_breach_line"');
    expect(text).not.toContain("SessionStore cap alert");
    expect(text).not.toContain("Day-to-date totals");
    expect(text).not.toContain("Scope: SessionStore projection only");
  });

  it("outcome notice routes through the renderer, composition literals gone", () => {
    const text = src("src/workflows/sagaOutcomeNotice.ts");
    expect(text).toContain('renderChannelText("saga_outcome_notice"');
    expect(text).not.toContain("Saga: ");
    expect(text).not.toContain(". Status: ");
  });

  it("journey prompt routes through the renderer", () => {
    const text = src("src/workflows/sagaJourneyGate.ts");
    expect(text).toContain('renderChannelText("saga_journey_prompt"');
  });
});
