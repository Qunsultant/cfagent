/**
 * Issue #1181 (#1173 R1): pipeline policy resolution.
 * Pins: sane defaults; precedence defaults < env < settings;
 * clamps; invalid values ignored (never throw); notification
 * toggles + event-list semantics; shouldNotify's full gate.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PIPELINE_POLICY,
  PIPELINE_POLICY_SETTING_KEYS,
  readPipelineSettings,
  resolvePipelinePolicy,
  shouldNotify,
} from "../src/services/pipelinePolicy";

describe("resolvePipelinePolicy", () => {
  it("defaults: 3 acquisition attempts, notifications fully on", () => {
    const p = resolvePipelinePolicy();
    expect(p.retry.acquisition.maxAttempts).toBe(3);
    expect(p.retry.delivery.maxAttempts).toBe(3);
    expect(p.retry.report.maxAttempts).toBe(2);
    expect(p.notifications.enabled).toBe(true);
    expect(p.notifications.events.failed).toBe(true);
    expect(p.fetchTimeoutMs).toBe(15_000);
    expect(p).toEqual(DEFAULT_PIPELINE_POLICY);
  });

  it("env overrides defaults (shared + per-class)", () => {
    const p = resolvePipelinePolicy({
      PIPELINE_RETRY_ATTEMPTS: "5",
      PIPELINE_DELIVERY_RETRY_ATTEMPTS: "2",
      PIPELINE_RETRY_BASE_DELAY_MS: "100",
    });
    expect(p.retry.acquisition.maxAttempts).toBe(5);
    expect(p.retry.delivery.maxAttempts).toBe(2);
    expect(p.retry.report.maxAttempts).toBe(5);
    expect(p.retry.acquisition.baseDelayMs).toBe(100);
  });

  it("settings beat env (operator tuning without a deploy)", () => {
    const p = resolvePipelinePolicy(
      { PIPELINE_RETRY_ATTEMPTS: "5" },
      { "pipeline.retry.attempts": "4", "pipeline.retry.delivery.attempts": "6" }
    );
    expect(p.retry.acquisition.maxAttempts).toBe(4);
    expect(p.retry.delivery.maxAttempts).toBe(6);
  });

  it("clamps attempts to 1..10 and keeps maxDelay >= baseDelay", () => {
    const p = resolvePipelinePolicy({
      PIPELINE_RETRY_ATTEMPTS: "99",
      PIPELINE_RETRY_BASE_DELAY_MS: "5000",
      PIPELINE_RETRY_MAX_DELAY_MS: "100",
    });
    expect(p.retry.acquisition.maxAttempts).toBe(10);
    expect(p.retry.acquisition.maxDelayMs).toBe(5000);
    const p0 = resolvePipelinePolicy({ PIPELINE_RETRY_ATTEMPTS: "0" });
    expect(p0.retry.acquisition.maxAttempts).toBe(1);
  });

  it("invalid values are ignored, never throw", () => {
    const p = resolvePipelinePolicy({
      PIPELINE_RETRY_ATTEMPTS: "banana",
      PIPELINE_NOTIFICATIONS: "maybe",
      PIPELINE_NOTIFY_EVENTS: "failed,unknown-event",
    });
    expect(p.retry.acquisition.maxAttempts).toBe(3);
    expect(p.notifications.enabled).toBe(true);
    // The one valid event still applies (list semantics: named = on).
    expect(p.notifications.events.failed).toBe(true);
    expect(p.notifications.events.completed).toBe(false);
  });

  it("notification toggles: master, channel, event list, -prefix", () => {
    const off = resolvePipelinePolicy({}, { "pipeline.notifications.enabled": "off" });
    expect(off.notifications.enabled).toBe(false);

    const onlyFailures = resolvePipelinePolicy({ PIPELINE_NOTIFY_EVENTS: "failed,blocked" });
    expect(onlyFailures.notifications.events.failed).toBe(true);
    expect(onlyFailures.notifications.events.blocked).toBe(true);
    expect(onlyFailures.notifications.events.completed).toBe(false);

    const noDelivered = resolvePipelinePolicy({ PIPELINE_NOTIFY_EVENTS: "-delivered" });
    expect(noDelivered.notifications.events.delivered).toBe(false);
    expect(noDelivered.notifications.events.failed).toBe(true);

    // Lifecycle 'started' is a first-class event (#1191).
    expect(resolvePipelinePolicy().notifications.events.started).toBe(true);
    const noStarted = resolvePipelinePolicy({ PIPELINE_NOTIFY_EVENTS: "-started" });
    expect(noStarted.notifications.events.started).toBe(false);
    expect(shouldNotify(noStarted, "started", "slack")).toBe(false);
    expect(shouldNotify(noStarted, "failed", "slack")).toBe(true);

    const noSlack = resolvePipelinePolicy({ PIPELINE_NOTIFY_SLACK: "0" });
    expect(noSlack.notifications.slack).toBe(false);
    expect(noSlack.notifications.email).toBe(true);
  });
});

describe("shouldNotify", () => {
  it("requires master + channel + event all on", () => {
    const p = resolvePipelinePolicy();
    expect(shouldNotify(p, "failed", "slack")).toBe(true);
    expect(shouldNotify(p, "completed", "email")).toBe(true);

    const noSlack = resolvePipelinePolicy({ PIPELINE_NOTIFY_SLACK: "off" });
    expect(shouldNotify(noSlack, "failed", "slack")).toBe(false);
    expect(shouldNotify(noSlack, "failed", "email")).toBe(true);

    const failuresOnly = resolvePipelinePolicy({ PIPELINE_NOTIFY_EVENTS: "failed" });
    expect(shouldNotify(failuresOnly, "completed", "slack")).toBe(false);
    expect(shouldNotify(failuresOnly, "failed", "slack")).toBe(true);

    const masterOff = resolvePipelinePolicy({ PIPELINE_NOTIFICATIONS: "off" });
    expect(shouldNotify(masterOff, "failed", "slack")).toBe(false);
  });
});

describe("jitterRatio override (#4782 S3)", () => {
  it("defaults to 0.25 in every bucket", () => {
    const p = resolvePipelinePolicy();
    expect(p.retry.acquisition.jitterRatio).toBe(0.25);
    expect(p.retry.delivery.jitterRatio).toBe(0.25);
    expect(p.retry.report.jitterRatio).toBe(0.25);
  });

  it("settings beat env beat shared beat default, per bucket and shared", () => {
    const p = resolvePipelinePolicy(
      {
        PIPELINE_RETRY_JITTER_RATIO: "0.5",
        PIPELINE_REPORT_RETRY_JITTER_RATIO: "0.4",
      },
      {
        "pipeline.retry.jitterRatio": "0.1",
        "pipeline.retry.delivery.jitterRatio": "0.2",
      },
    );
    // Shared settings win over shared env where no per-bucket
    // value exists (acquisition)…
    expect(p.retry.acquisition.jitterRatio).toBe(0.1);
    // …a per-bucket setting wins outright (delivery)…
    expect(p.retry.delivery.jitterRatio).toBe(0.2);
    // …and a per-bucket env beats a shared setting (report): the
    // chain is per-bucket settings, per-bucket env, then shared.
    expect(p.retry.report.jitterRatio).toBe(0.4);
  });

  it("per-bucket env beats shared env when no settings are present", () => {
    const p = resolvePipelinePolicy({
      PIPELINE_RETRY_JITTER_RATIO: "0.5",
      PIPELINE_REPORT_RETRY_JITTER_RATIO: "0.4",
    });
    expect(p.retry.acquisition.jitterRatio).toBe(0.5);
    expect(p.retry.delivery.jitterRatio).toBe(0.5);
    expect(p.retry.report.jitterRatio).toBe(0.4);
  });

  it("clamps jitterRatio to 0..1", () => {
    const p = resolvePipelinePolicy({
      PIPELINE_RETRY_JITTER_RATIO: "1.5",
      PIPELINE_DELIVERY_RETRY_JITTER_RATIO: "-0.2",
    });
    expect(p.retry.acquisition.jitterRatio).toBe(1);
    expect(p.retry.delivery.jitterRatio).toBe(0);
    expect(p.retry.report.jitterRatio).toBe(1);
  });

  it("ignores a non-numeric jitterRatio, never throws", () => {
    const p = resolvePipelinePolicy(
      { PIPELINE_RETRY_JITTER_RATIO: "abc" },
      { "pipeline.retry.acquisition.jitterRatio": "not-a-number" },
    );
    expect(p.retry.acquisition.jitterRatio).toBe(0.25);
    expect(p.retry.delivery.jitterRatio).toBe(0.25);
  });
});

describe("readPipelineSettings (#4782 S3)", () => {
  it("builds the settings map from a reader, skipping absent keys", () => {
    const store: Record<string, string> = {
      "pipeline.retry.report.attempts": "1",
      "pipeline.retry.jitterRatio": "0",
    };
    const seen: string[] = [];
    const map = readPipelineSettings((key) => {
      seen.push(key);
      return store[key] ?? null;
    });
    expect(map).toEqual({
      "pipeline.retry.report.attempts": "1",
      "pipeline.retry.jitterRatio": "0",
    });
    // Only the keys the resolver reads are ever asked for.
    expect(seen).toEqual([...PIPELINE_POLICY_SETTING_KEYS]);
    expect(seen).toContain("pipeline.retry.report.attempts");
    expect(seen).toContain("pipeline.retry.acquisition.jitterRatio");
    expect(seen).toContain("pipeline.notifications.enabled");
    expect(seen).toContain("pipeline.fetchTimeoutMs");
  });

  it("returns an empty map when the reader has nothing", () => {
    expect(readPipelineSettings(() => null)).toEqual({});
  });
});
