// @vitest-environment node
/**
 * Issue #4234 (ADR 0030) — the heartbeat tick's due-checks: the
 * token-renewal and retention duties run inside the one alarm tick,
 * once daily after their due hour (UTC), never as separate crons.
 *
 * Pinned behaviors:
 * - Config (`resolveHeartbeatDueCheckConfig`): renewal defaults to
 *   03:00 UTC, retention to 04:00 UTC. Blank, unparseable, or
 *   out-of-range (not an integer hour 0–23) values fall through to
 *   the defaults — the duties have no disabling value.
 * - Pure predicates (`isRenewalDue` / `isRetentionDue`): due when
 *   the duty never ran, or when its last successful run was before
 *   the most recent due-hour boundary that has already passed. A
 *   run exactly at the boundary counts (not due). Before today's
 *   due hour, the boundary is yesterday's — the duty does not fire
 *   early.
 * - Runner (`runHeartbeatDueChecks`): runs each due duty once,
 *   reports what ran, never throws (a failing duty is logged and
 *   retried on the next tick — the last-run read only counts
 *   successful ledger rows, so a failure leaves the duty due).
 */
import { describe, it, expect, vi } from "vitest";

import {
  DEFAULT_HEARTBEAT_RENEWAL_DUE_HOUR_UTC,
  DEFAULT_HEARTBEAT_RETENTION_DUE_HOUR_UTC,
  resolveHeartbeatDueCheckConfig,
  type HeartbeatDueCheckConfig,
} from "../src/config/heartbeatWatchdog";
import {
  RENEWAL_DISPATCH_CRON,
  RETENTION_DISPATCH_CRON,
  isRenewalDue,
  isRetentionDue,
  runHeartbeatDueChecks,
} from "../src/services/heartbeatDueChecks";

const CONFIG: HeartbeatDueCheckConfig = {
  renewalDueHourUtc: 3,
  retentionDueHourUtc: 4,
};

const utc = (iso: string) => new Date(iso);

describe("heartbeat due-check config (#4234)", () => {
  it("defaults renewal to 03:00 UTC and retention to 04:00 UTC", () => {
    expect(DEFAULT_HEARTBEAT_RENEWAL_DUE_HOUR_UTC).toBe(3);
    expect(DEFAULT_HEARTBEAT_RETENTION_DUE_HOUR_UTC).toBe(4);
    expect(resolveHeartbeatDueCheckConfig({})).toEqual({
      renewalDueHourUtc: 3,
      retentionDueHourUtc: 4,
    });
  });

  it("honours owner-set due hours", () => {
    expect(
      resolveHeartbeatDueCheckConfig({
        HEARTBEAT_RENEWAL_DUE_HOUR_UTC: "5",
        HEARTBEAT_RETENTION_DUE_HOUR_UTC: "6",
      }),
    ).toEqual({ renewalDueHourUtc: 5, retentionDueHourUtc: 6 });
  });

  it("falls through to defaults on blank, unparseable, or out-of-range values", () => {
    for (const bad of ["", "  ", "soon", "-1", "24", "25"]) {
      expect(
        resolveHeartbeatDueCheckConfig({
          HEARTBEAT_RENEWAL_DUE_HOUR_UTC: bad,
        }),
      ).toEqual({ renewalDueHourUtc: 3, retentionDueHourUtc: 4 });
      expect(
        resolveHeartbeatDueCheckConfig({
          HEARTBEAT_RETENTION_DUE_HOUR_UTC: bad,
        }),
      ).toEqual({ renewalDueHourUtc: 3, retentionDueHourUtc: 4 });
    }
  });

  it("floors a fractional hour", () => {
    expect(
      resolveHeartbeatDueCheckConfig({
        HEARTBEAT_RENEWAL_DUE_HOUR_UTC: "3.9",
      }),
    ).toEqual({ renewalDueHourUtc: 3, retentionDueHourUtc: 4 });
  });

  it("names the dispatch crons as the ledger jobIds (S1: a cron run's jobId IS its cron expression)", () => {
    expect(RENEWAL_DISPATCH_CRON).toBe("0 3 * * *");
    expect(RETENTION_DISPATCH_CRON).toBe("0 4 * * *");
  });
});

describe("isRenewalDue / isRetentionDue (pure, #4234)", () => {
  it("a duty that never ran is due", () => {
    expect(
      isRenewalDue(utc("2026-11-13T12:00:00Z"), null, CONFIG),
    ).toBe(true);
    expect(
      isRetentionDue(utc("2026-11-13T12:00:00Z"), null, CONFIG),
    ).toBe(true);
  });

  it("a run yesterday is due after today's due hour", () => {
    const now = utc("2026-11-13T12:00:00Z");
    expect(
      isRenewalDue(now, utc("2026-11-12T03:05:00Z").getTime(), CONFIG),
    ).toBe(true);
    expect(
      isRetentionDue(now, utc("2026-11-12T04:05:00Z").getTime(), CONFIG),
    ).toBe(true);
  });

  it("a run after today's due hour is not due again today", () => {
    const now = utc("2026-11-13T12:00:00Z");
    expect(
      isRenewalDue(now, utc("2026-11-13T03:05:00Z").getTime(), CONFIG),
    ).toBe(false);
    expect(
      isRetentionDue(now, utc("2026-11-13T04:05:00Z").getTime(), CONFIG),
    ).toBe(false);
  });

  it("a run exactly at today's due-hour boundary counts (not due)", () => {
    const now = utc("2026-11-13T12:00:00Z");
    expect(
      isRenewalDue(now, utc("2026-11-13T03:00:00Z").getTime(), CONFIG),
    ).toBe(false);
    expect(
      isRetentionDue(now, utc("2026-11-13T04:00:00Z").getTime(), CONFIG),
    ).toBe(false);
  });

  it("before today's due hour, yesterday's run is not due yet (no early firing)", () => {
    const now = utc("2026-11-13T02:00:00Z");
    expect(
      isRenewalDue(now, utc("2026-11-12T03:05:00Z").getTime(), CONFIG),
    ).toBe(false);
    expect(
      isRetentionDue(now, utc("2026-11-12T04:05:00Z").getTime(), CONFIG),
    ).toBe(false);
  });

  it("at the due hour itself, yesterday's run is due", () => {
    const now = utc("2026-11-13T03:00:00Z");
    expect(
      isRenewalDue(now, utc("2026-11-12T03:05:00Z").getTime(), CONFIG),
    ).toBe(true);
    // Retention's hour has not arrived yet at 03:00.
    expect(
      isRetentionDue(now, utc("2026-11-12T04:05:00Z").getTime(), CONFIG),
    ).toBe(false);
  });
});

describe("runHeartbeatDueChecks (#4234)", () => {
  function makeDeps(overrides: Record<string, unknown> = {}) {
    const runRenewal = vi.fn(async () => undefined);
    const runRetention = vi.fn(async () => undefined);
    const logError = vi.fn();
    const logInfo = vi.fn();
    const deps = {
      now: () => utc("2026-11-13T12:00:00Z"),
      lastRenewalAtMs: null as number | null,
      lastRetentionAtMs: null as number | null,
      config: CONFIG,
      runRenewal,
      runRetention,
      logError,
      logInfo,
      ...overrides,
    };
    return { deps, runRenewal, runRetention, logError, logInfo };
  }

  it("runs both duties when both are due and reports them", async () => {
    const { deps, runRenewal, runRetention } = makeDeps();
    const result = await runHeartbeatDueChecks(deps);
    expect(runRenewal).toHaveBeenCalledTimes(1);
    expect(runRetention).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ renewalRan: true, retentionRan: true });
  });

  it("runs neither when neither is due", async () => {
    const { deps, runRenewal, runRetention } = makeDeps({
      lastRenewalAtMs: utc("2026-11-13T03:05:00Z").getTime(),
      lastRetentionAtMs: utc("2026-11-13T04:05:00Z").getTime(),
    });
    const result = await runHeartbeatDueChecks(deps);
    expect(runRenewal).not.toHaveBeenCalled();
    expect(runRetention).not.toHaveBeenCalled();
    expect(result).toEqual({ renewalRan: false, retentionRan: false });
  });

  it("runs only the due duty", async () => {
    const { deps, runRenewal, runRetention } = makeDeps({
      lastRenewalAtMs: utc("2026-11-13T03:05:00Z").getTime(),
    });
    const result = await runHeartbeatDueChecks(deps);
    expect(runRenewal).not.toHaveBeenCalled();
    expect(runRetention).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ renewalRan: false, retentionRan: true });
  });

  it("a failing duty is logged, reported as not run, and never fails the tick", async () => {
    const { deps, runRenewal, runRetention, logError } = makeDeps();
    runRenewal.mockRejectedValueOnce(new Error("token store unavailable"));
    const result = await runHeartbeatDueChecks(deps);
    expect(result).toEqual({ renewalRan: false, retentionRan: true });
    expect(runRetention).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalled();
    expect(String(logError.mock.calls[0]?.[0] ?? "")).toContain(
      "token store unavailable",
    );
  });
});
