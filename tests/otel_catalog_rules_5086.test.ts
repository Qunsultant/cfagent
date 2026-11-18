/**
 * Issue #5086 (S7, observability program #5080) — the real alert
 * rules: S4 built only the owner module + port with PLACEHOLDER
 * rules (owner decision, S7 option b). S7 defines the real
 * severity/rule catalog; the three first consumers resolve
 * through it.
 *
 * TDD Red first: the real rules (src/observability/otelMessages.ts
 * catalog + the port's rule resolution) do not exist yet, so this
 * file fails at import / on the new behavior.
 *
 * Rules:
 *  - rule:stuck-run -> OBS-1017 (warning), the sweep stuck-run alert.
 *  - rule:cap-breach -> OBS-1018 (warning), the SessionStore cap alert.
 *  - rule:ci-failure -> OBS-1019 (error), the CI failure alert.
 *  - The severity comes from the catalog, never from a hardcoded
 *    string at a call site.
 *  - An unknown rule id is REJECTED (OBS-1021, not delivered,
 *    never silently passed); a placeholder-* rule id still works
 *    (placeholderRules: true) for consumers not yet catalogued.
 */
import { describe, it, expect } from "vitest";
import {
  OBS_ALERTING_CAP_BREACH,
  OBS_ALERTING_CI_FAILURE,
  OBS_ALERTING_RULE_UNKNOWN,
  OBS_ALERTING_STUCK_RUN,
  resolveAlertRule,
} from "../src/observability/otelMessages";
import {
  createAlertingPort,
  type AlertReport,
  type AlertingPortDeps,
} from "../src/observability/otelAlerting";
import type { EmailSender } from "../src/services/emailSenderPorts";
import type { SlackPostFn } from "../src/agents/social/delivery";

function makeSlackPost(): {
  fn: SlackPostFn;
  calls: Array<{ url: string; headers: Record<string, string>; body: string }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fn: SlackPostFn = async (url, headers, body) => {
    calls.push({ url, headers, body });
    if (url === "https://slack.com/api/chat.postMessage") {
      return { status: 200, body: JSON.stringify({ ok: true }) };
    }
    return { status: 200, body: "" };
  };
  return { fn, calls };
}

function makeEmailSender(): { sender: EmailSender; sent: Array<{ to: string; subject: string }> } {
  const sent: Array<{ to: string; subject: string }> = [];
  const sender: EmailSender = {
    send: async (message) => {
      sent.push({ to: message.to, subject: message.subject });
      return true;
    },
  };
  return { sender, sent };
}

function makeEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
        SLACK_BOT_TOKEN: "test-slack-token",
    SCREENER_SLACK_CHANNEL: "C0CAFAQ8S9M",
    CHANNEL_EMAIL_PRINCIPALS: JSON.stringify({
      "owner@example.com": { login: "owner", tier: "trade" },
    }),
    OTEL_ALERTING_ENABLED: "true",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<AlertingPortDeps> = {}): AlertingPortDeps {
  const slack = makeSlackPost();
  const email = makeEmailSender();
  return {
    env: makeEnv() as never,
    slackPost: slack.fn,
    emailSender: email.sender,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    } as never,
    ...overrides,
  };
}

describe("S7 alert rules (#5086)", () => {
  it("resolves the three first consumers through the catalog", () => {
    const stuck = resolveAlertRule("rule:stuck-run");
    expect(stuck.ok).toBe(true);
    if (stuck.ok) {
      expect(stuck.rule.code).toBe(OBS_ALERTING_STUCK_RUN);
      expect(stuck.rule.severity).toBe("warning");
    }
    const cap = resolveAlertRule("rule:cap-breach");
    expect(cap.ok).toBe(true);
    if (cap.ok) {
      expect(cap.rule.code).toBe(OBS_ALERTING_CAP_BREACH);
      expect(cap.rule.severity).toBe("warning");
    }
    const ci = resolveAlertRule("rule:ci-failure");
    expect(ci.ok).toBe(true);
    if (ci.ok) {
      expect(ci.rule.code).toBe(OBS_ALERTING_CI_FAILURE);
      expect(ci.rule.severity).toBe("error");
    }
  });

  it("rejects an unknown rule id (never silently passed)", () => {
    const resolved = resolveAlertRule("rule:does-not-exist");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toMatch(/not in the alert-rule catalog/);
  });

  it("delivers a catalog-ruled alert with the catalog severity", async () => {
    const slack = makeSlackPost();
    const email = makeEmailSender();
    const port = createAlertingPort(
      makeDeps({ slackPost: slack.fn, emailSender: email.sender }),
    );
    const report: AlertReport = {
      source: "sweep",
      code: OBS_ALERTING_STUCK_RUN,
      ruleId: "rule:stuck-run",
      title: "Stuck run: job-1",
      text: "Job job-1 has been running for 45 minutes.",
      runId: "job-1",
    };
    const result = await port.reportAlert(report);
    expect(result.delivered).toBe(true);
    expect(result.placeholderRules).toBe(false);
    expect(result.severity).toBe("warning");
    expect(result.code).toBe(OBS_ALERTING_STUCK_RUN);
    expect(slack.calls.length).toBeGreaterThan(0);
    expect(email.sent.length).toBe(1);
  });

  it("rejects an unknown non-placeholder rule id with OBS-1021 and sends nothing", async () => {
    const slack = makeSlackPost();
    const email = makeEmailSender();
    const port = createAlertingPort(
      makeDeps({ slackPost: slack.fn, emailSender: email.sender }),
    );
    const report: AlertReport = {
      source: "other",
      code: OBS_ALERTING_STUCK_RUN,
      ruleId: "rule:does-not-exist",
      title: "Bogus",
      text: "This rule does not exist.",
    };
    const result = await port.reportAlert(report);
    expect(result.delivered).toBe(false);
    expect(result.code).toBe(OBS_ALERTING_RULE_UNKNOWN);
    expect(result.placeholderRules).toBe(false);
    expect(slack.calls.length).toBe(0);
    expect(email.sent.length).toBe(0);
  });

  it("still delivers a placeholder-ruled alert (placeholderRules: true)", async () => {
    const slack = makeSlackPost();
    const email = makeEmailSender();
    const port = createAlertingPort(
      makeDeps({ slackPost: slack.fn, emailSender: email.sender }),
    );
    const report: AlertReport = {
      source: "other",
      code: OBS_ALERTING_STUCK_RUN,
      severity: "warning",
      ruleId: "placeholder-future-consumer",
      title: "Future",
      text: "Not yet catalogued.",
    };
    const result = await port.reportAlert(report);
    expect(result.delivered).toBe(true);
    expect(result.placeholderRules).toBe(true);
    expect(result.severity).toBe("warning");
  });
});
