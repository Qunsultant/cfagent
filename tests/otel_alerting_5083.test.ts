/**
 * Issue #5083 (S4, observability program #5080) — the one
 * error-reporting owner module + one alerting port.
 *
 * TDD Red first: the port module (src/observability/otelAlerting.ts)
 * does not exist yet, so this file fails at import.
 *
 * S4 is the single path every error report takes to reach a human:
 * Slack (SCREENER_SLACK_CHANNEL) AND email (CHANNEL_EMAIL_PRINCIPALS)
 * — both, every alert goes to both. Credentials come from GitHub
 * secrets (Worker secrets), never hardcoded. Never an approval
 * card: alerts are notifications, not approvals.
 *
 * The port CONSUMES logs/metrics/audit (it reads them to enrich
 * the alert and records the alert through the structured logger);
 * it does not replace or duplicate them. No second store.
 *
 * S7 dependency (owner decision, option b): S4 builds ONLY the
 * owner module + port with PLACEHOLDER rules. The alert
 * rules/severities catalog lands with S7 (#5086). The port
 * accepts a severity + rule id from the caller but S4 does NOT
 * define the real rule/severity catalog — placeholders, clearly
 * marked, to be replaced by S7. No second catalog.
 *
 * The three first consumers (owner decision: ALL wired first):
 * sweep alerts (#3784), the 70% SessionStore cap alert (#1819),
 * and CI failure alerts. Each routes through this port; what
 * triggers them does not change, only the delivery path.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createAlertingPort,
  type AlertReport,
  type AlertingPortDeps,
} from "../src/observability/otelAlerting";
import type { EmailSender } from "../src/services/emailSenderPorts";
import type { SlackPostFn } from "../src/agents/social/delivery";

/** A fake Slack poster that records calls and succeeds. */
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

/** A fake EmailSender that records sends and succeeds. */
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

/** A minimal alert report. */
function makeReport(overrides: Partial<AlertReport> = {}): AlertReport {
  return {
    source: "sweep",
    code: "OBS-1014",
    // PLACEHOLDER severity + rule id (S7 defines the real catalog).
    severity: "warning",
    ruleId: "placeholder-sweep-stuck-run",
    title: "Stuck run alert",
    text: "Job job-1 has been running for 45 minutes.",
    ...overrides,
  };
}

/** Env with Slack + email configured (secrets as Worker env vars). */
function makeEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SCREENER_SLACK_CHANNEL: "C0CAFAQ8S9M",
    CHANNEL_EMAIL_PRINCIPALS: JSON.stringify({
      "owner@example.com": { login: "owner", tier: "trade" },
    }),
    OTEL_ALERTING_ENABLED: "true",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<AlertingPortDeps> = {}): {
  deps: AlertingPortDeps;
  slack: ReturnType<typeof makeSlackPost>;
  email: ReturnType<typeof makeEmailSender>;
} {
  const slack = makeSlackPost();
  const email = makeEmailSender();
  const deps: AlertingPortDeps = {
    env: makeEnv(),
    slackPost: slack.fn,
    emailSender: email.sender,
    ...overrides,
  };
  return { deps, slack, email };
}

describe("S4 alerting port (one owner + one port)", () => {
  it("routes an alert to Slack AND email — both, every alert", async () => {
    const { deps, slack, email } = makeDeps();
    const port = createAlertingPort(deps);
    const result = await port.reportAlert(makeReport());
    expect(result.delivered).toBe(true);
    expect(result.slack.ok).toBe(true);
    expect(result.email.ok).toBe(true);
    expect(slack.calls.length).toBeGreaterThan(0);
    expect(email.sent.length).toBe(1);
    expect(email.sent[0].to).toBe("owner@example.com");
  });

  it("the Slack text carries the alert title + body (plain text, never an approval card)", async () => {
    const { deps, slack } = makeDeps();
    const port = createAlertingPort(deps);
    await port.reportAlert(makeReport({ title: "Cap alert", text: "rowsRead at 72% of budget." }));
    const body = slack.calls.map((c) => c.body).join(" ");
    expect(body).toContain("Cap alert");
    expect(body).toContain("rowsRead at 72%");
    // Never an approval card: no Block Kit buttons ride an alert.
    expect(body).not.toContain("Approve");
    expect(body).not.toContain("Reject");
    expect(body).not.toContain("blocks");
  });

  it("alerting OFF (master) sends nothing to either channel", async () => {
    const { deps, slack, email } = makeDeps({
      env: makeEnv({ OTEL_ALERTING_ENABLED: "false" }),
    });
    const port = createAlertingPort(deps);
    const result = await port.reportAlert(makeReport());
    expect(result.delivered).toBe(false);
    expect(slack.calls.length).toBe(0);
    expect(email.sent.length).toBe(0);
  });

  it("Slack channel OFF sends email only; email OFF sends Slack only", async () => {
    const slackOnly = makeDeps({ env: makeEnv({ OTEL_ALERTING_EMAIL_ENABLED: "false" }) });
    const r1 = await createAlertingPort(slackOnly.deps).reportAlert(makeReport());
    expect(r1.slack.ok).toBe(true);
    expect(r1.email.ok).toBe(false);
    expect(slackOnly.email.sent.length).toBe(0);

    const emailOnly = makeDeps({ env: makeEnv({ OTEL_ALERTING_SLACK_ENABLED: "false" }) });
    const r2 = await createAlertingPort(emailOnly.deps).reportAlert(makeReport());
    expect(r2.slack.ok).toBe(false);
    expect(r2.email.ok).toBe(true);
    expect(emailOnly.slack.calls.length).toBe(0);
  });

  it("an invalid alerting config value fails closed to OFF with OBS-1001 (no send)", async () => {
    const { deps, slack, email } = makeDeps({
      env: makeEnv({ OTEL_ALERTING_ENABLED: "not-a-boolean" }),
    });
    const port = createAlertingPort(deps);
    const result = await port.reportAlert(makeReport());
    expect(result.delivered).toBe(false);
    expect(slack.calls.length).toBe(0);
    expect(email.sent.length).toBe(0);
  });

  it("a Slack failure does not throw and does not block the email leg", async () => {
    const failingSlack: SlackPostFn = async () => {
      throw new Error("network down");
    };
    const { deps, email } = makeDeps({ slackPost: failingSlack });
    const port = createAlertingPort(deps);
    const result = await port.reportAlert(makeReport());
    expect(result.slack.ok).toBe(false);
    expect(result.email.ok).toBe(true);
    expect(email.sent.length).toBe(1);
  });

  it("no Slack destination and no email binding returns a missing-destination result (OBS-1015), never a throw", async () => {
    const { deps } = makeDeps({
      env: makeEnv({
        SLACK_BOT_TOKEN: undefined,
        SLACK_WEBHOOK_URL: undefined,
        CHANNEL_EMAIL_PRINCIPALS: "{}",
      }),
      emailSender: null,
    });
    const port = createAlertingPort(deps);
    const result = await port.reportAlert(makeReport());
    expect(result.delivered).toBe(false);
    expect(result.code).toBe("OBS-1015");
  });

  it("email recipients are the CHANNEL_EMAIL_PRINCIPALS keys (one email per principal)", async () => {
    const { deps, email } = makeDeps({
      env: makeEnv({
        CHANNEL_EMAIL_PRINCIPALS: JSON.stringify({
          "a@example.com": { login: "a", tier: "read" },
          "b@example.com": { login: "b", tier: "trade" },
        }),
      }),
    });
    const port = createAlertingPort(deps);
    await port.reportAlert(makeReport());
    expect(email.sent.map((s) => s.to).sort()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("a malformed CHANNEL_EMAIL_PRINCIPALS map sends no email (fail-closed, no throw)", async () => {
    const { deps, slack, email } = makeDeps({
      env: makeEnv({ CHANNEL_EMAIL_PRINCIPALS: "not-json{{" }),
    });
    const port = createAlertingPort(deps);
    const result = await port.reportAlert(makeReport());
    expect(email.sent.length).toBe(0);
    // Slack still delivers — one channel failing never blocks the other.
    expect(result.slack.ok).toBe(true);
    expect(slack.calls.length).toBeGreaterThan(0);
  });

  it("severity + ruleId are PLACEHOLDERS (S7 defines the real catalog) — the report marks them as such", async () => {
    const { deps } = makeDeps();
    const port = createAlertingPort(deps);
    const report = makeReport();
    // The placeholder marker is part of the report contract: S4 does
    // not define a real severity/rule catalog (no second catalog).
    expect(report.severity).toBe("warning");
    expect(report.ruleId).toMatch(/^placeholder-/);
    const result = await port.reportAlert(report);
    expect(result.delivered).toBe(true);
    expect(result.placeholderRules).toBe(true);
  });

  it("the port records the alert through the structured logger (consumes logs, does not duplicate them)", async () => {
    const logged: Array<{ operation: string }> = [];
    const logger = {
      info: (op: string) => {
        logged.push({ operation: op });
      },
      warn: () => undefined,
      error: () => undefined,
    };
    const { deps } = makeDeps({ logger: logger as never });
    const port = createAlertingPort(deps);
    await port.reportAlert(makeReport());
    expect(logged.some((e) => e.operation.includes("alert"))).toBe(true);
  });

  it("the free-tier guard drops alerts past maxAlertsPerDay with ONE OBS-1016 per day", async () => {
    const { deps, slack, email } = makeDeps({
      env: makeEnv({ OTEL_ALERTING_MAX_ALERTS_PER_DAY: "2" }),
    });
    const port = createAlertingPort(deps);
    const r1 = await port.reportAlert(makeReport());
    const r2 = await port.reportAlert(makeReport());
    const r3 = await port.reportAlert(makeReport());
    expect(r1.delivered).toBe(true);
    expect(r2.delivered).toBe(true);
    // Third alert is dropped by the guard.
    expect(r3.delivered).toBe(false);
    expect(r3.code).toBe("OBS-1016");
    expect(slack.calls.length).toBe(2);
    expect(email.sent.length).toBe(2);
  });

  it("the port never throws, even when both channels fail", async () => {
    const failingSlack: SlackPostFn = async () => {
      throw new Error("slack down");
    };
    const failingEmail: EmailSender = {
      send: async () => {
        throw new Error("email down");
      },
    };
    const { deps } = makeDeps({ slackPost: failingSlack, emailSender: failingEmail });
    const port = createAlertingPort(deps);
    const result = await port.reportAlert(makeReport());
    expect(result.delivered).toBe(false);
    expect(result.code).toBe("OBS-1014");
  });

  it("credentials come from env (GitHub secrets), never hardcoded: the Slack post carries the env bot token", async () => {
    const { deps, slack } = makeDeps({
      env: makeEnv({ SLACK_BOT_TOKEN: "xoxb-env-provided-token" }),
    });
    const port = createAlertingPort(deps);
    await port.reportAlert(makeReport());
    expect(slack.calls.length).toBeGreaterThan(0);
    const chatCall = slack.calls.find((c) => c.url === "https://slack.com/api/chat.postMessage");
    expect(chatCall).toBeDefined();
    // The token in the Authorization header is the env value —
    // the port never carries a secret literal of its own.
    expect(chatCall!.headers.Authorization).toBe("Bearer xoxb-env-provided-token");
  });

  it("all three first consumers route through the port (sweep, cap-alert, ci-failure)", async () => {
    const { deps, slack, email } = makeDeps();
    const port = createAlertingPort(deps);
    for (const source of ["sweep", "cap-alert", "ci-failure"] as const) {
      const result = await port.reportAlert(makeReport({ source }));
      expect(result.delivered).toBe(true);
    }
    expect(slack.calls.length).toBe(3);
    expect(email.sent.length).toBe(3);
  });
});
