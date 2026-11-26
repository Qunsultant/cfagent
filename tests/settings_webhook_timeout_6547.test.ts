// @vitest-environment node
/**
 * Issue #6547 — the settings-change delivery is bounded, so a hung fetch cannot
 * hold the OrchestratorAgent resident.
 *
 * The notifier delivers through the instance's own webhook channel, deferred
 * through the DO context's `waitUntil`. A pending I/O operation can hold a
 * Durable Object in memory for up to 15 minutes; with no timeout and no abort
 * signal, a hung self-delivery made the `waitUntil` promise never settle — and
 * the failure was silent, because the delivery never throws by contract.
 *
 * Pins:
 *  - 6547-P01 a hung delivery settles as not-delivered within the bound, and
 *    never throws into the write path;
 *  - 6547-P02 the request carries an abort signal (the mechanism that makes
 *    the platform fetch give up);
 *  - 6547-P03 the bound is externalized (`SETTINGS_WEBHOOK_TIMEOUT_MS`), with a
 *    documented default and clamp — not a constant in the delivery body;
 *  - 6547-P04 a healthy delivery is unchanged.
 */
import { describe, expect, it } from "vitest";
import {
  SETTINGS_WEBHOOK_TIMEOUT_ENV_VAR,
  deliverSettingsChangeWebhook,
  resolveSettingsWebhookTimeoutMs,
  type SettingsChange,
} from "../src/agents/settingsWebhookNotify";
import { THINK_WEBHOOK_SECRET_ENV } from "../src/actors/thinkPortMapping";

const LOGIN = "owner@example.com";
const SECRET = "test-secret";
const CHANGED_AT = "2026-11-26T12:00:00.000Z";

const change: SettingsChange = {
  kind: "mode_changed",
  login: LOGIN,
  changedAt: CHANGED_AT,
};

/** A namespace whose delivery hangs until the request's own signal aborts. */
function hangingNamespace() {
  const signals: Array<AbortSignal | undefined> = [];
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: (request: Request) =>
        new Promise<Response>((_resolve, reject) => {
          signals.push(request.signal);
          if (!request.signal) return; // no signal ⇒ never settles (the defect)
          request.signal.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    }),
  };
  return { ns, signals };
}

/** A namespace that answers normally. */
function respondingNamespace() {
  const received: Request[] = [];
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (request: Request) => {
        received.push(request);
        return new Response("OK");
      },
    }),
  };
  return { ns, received };
}

describe("6547-P01 a hung delivery settles within the bound", () => {
  it("reports not-delivered instead of holding the object open", async () => {
    const { ns } = hangingNamespace();
    const env = {
      [THINK_WEBHOOK_SECRET_ENV]: SECRET,
      ORCHESTRATOR_AGENT: ns,
      [SETTINGS_WEBHOOK_TIMEOUT_ENV_VAR]: "25",
    };
    const started = Date.now();

    const out = await deliverSettingsChangeWebhook(env as never, change);

    // Settled, bounded, and honest: the write stands, the delivery did not.
    expect(out.delivered).toBe(false);
    expect(out.reason).toContain("25");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("6547-P02 the request carries an abort signal", () => {
  it("hands the platform fetch a signal that can fire", async () => {
    const { ns, received } = respondingNamespace();
    await deliverSettingsChangeWebhook(
      {
        [THINK_WEBHOOK_SECRET_ENV]: SECRET,
        ORCHESTRATOR_AGENT: ns,
      } as never,
      change,
    );

    expect(received).toHaveLength(1);
    expect(received[0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("6547-P03 the bound is configuration", () => {
  it("reads the env var, clamps it, and defaults when unset", () => {
    const read = (value?: string) =>
      resolveSettingsWebhookTimeoutMs(
        (value === undefined ? {} : { [SETTINGS_WEBHOOK_TIMEOUT_ENV_VAR]: value }) as never,
      );

    expect(read("2500")).toBe(2_500);
    // Clamped, never trusted verbatim: a negative/blank/garbage value can
    // neither disable the bound nor make it absurd.
    expect(read("-1")).toBeGreaterThan(0);
    expect(read("soon")).toBeGreaterThan(0);
    expect(read(undefined)).toBeGreaterThan(0);
    expect(read("600000")).toBeLessThanOrEqual(60_000);
  });
});

describe("6547-P04 a healthy delivery is unchanged", () => {
  it("still delivers and still never throws", async () => {
    const { ns, received } = respondingNamespace();

    const out = await deliverSettingsChangeWebhook(
      {
        [THINK_WEBHOOK_SECRET_ENV]: SECRET,
        ORCHESTRATOR_AGENT: ns,
      } as never,
      change,
    );

    expect(out).toEqual({ delivered: true });
    expect(received[0].url).toContain("/webhooks/settings");
  });
});
