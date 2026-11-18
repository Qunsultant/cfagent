/**
 * Issue #5083 (S4, observability program #5080) — the CI failure
 * alert ingestion route: POST /api/otel/v1/alerts.
 *
 * TDD Red first: OTEL_ALERTS_INGESTION_ROUTE and the alerts
 * branch in handleOtelRoutes do not exist yet, so this file fails
 * at import.
 *
 * This is how CI failures (GitHub Actions, the
 * ci-failure-self-heal workflow) reach the Worker alerting port:
 * the workflow POSTs a JSON alert report when it files a new
 * [QA self-heal] issue. The route is gated by the same
 * OTEL_INGEST_TOKEN as the OTLP routes (the workflow reads it
 * from the GitHub secret of the same name — the same value as
 * the Worker secret). No token = 404 (the external surface is
 * disabled). Wrong token = 401. Non-POST = 405.
 *
 * The route routes the report through the S4 alerting port
 * (Slack + email). It never throws for a delivery failure —
 * the workflow must not fail because an alert did not deliver.
 */
import { describe, it, expect } from "vitest";
import {
  handleOtelRoutes,
  OTEL_ALERTS_INGESTION_ROUTE,
} from "../src/server/routes/otel";
import type { AlertingPort, AlertReport, AlertResult } from "../src/observability/otelAlerting";
import type { Env } from "../src/types";

/** A fake alerting port that records reports and succeeds. */
function makeFakePort(): { port: AlertingPort; reports: AlertReport[] } {
  const reports: AlertReport[] = [];
  const port: AlertingPort = {
    reportAlert: async (report: AlertReport): Promise<AlertResult> => {
      reports.push(report);
      return {
        delivered: true,
        slack: { ok: true, method: "bot" },
        email: { ok: true, sentTo: ["owner@example.com"] },
        code: report.code,
        placeholderRules: true,
      };
    },
  };
  return { port, reports };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    OTEL_INGEST_TOKEN: "test-ingest-token",
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SCREENER_SLACK_CHANNEL: "C0CAFAQ8S9M",
    CHANNEL_EMAIL_PRINCIPALS: JSON.stringify({
      "owner@example.com": { login: "owner", tier: "trade" },
    }),
    ...overrides,
  } as Env;
}

function postAlert(
  env: Env,
  body: unknown,
  token?: string,
  alertPort?: AlertingPort,
): Promise<Response | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return handleOtelRoutes(
    new Request(`https://agent.openaimp.com${OTEL_ALERTS_INGESTION_ROUTE}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    env,
    new URL(`https://agent.openaimp.com${OTEL_ALERTS_INGESTION_ROUTE}`),
    OTEL_ALERTS_INGESTION_ROUTE,
    alertPort,
  );
}

const CI_ALERT = {
  source: "ci-failure",
  workflow: "Continuous Integration & Test Verification",
  runId: "123456",
  runUrl: "https://github.com/Qunsultant/cfagent/actions/runs/123456",
  conclusion: "failure",
  headBranch: "main",
};

describe("S4 CI failure alert route (POST /api/otel/v1/alerts)", () => {
  it("the route path is /api/otel/v1/alerts", () => {
    expect(OTEL_ALERTS_INGESTION_ROUTE).toBe("/api/otel/v1/alerts");
  });

  it("a valid CI failure report with the right token is accepted (200) and routed through the port", async () => {
    const fake = makeFakePort();
    const res = await postAlert(makeEnv(), CI_ALERT, "test-ingest-token", fake.port);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { received?: boolean; delivered?: boolean };
    expect(body.received).toBe(true);
    expect(body.delivered).toBe(true);
    // The report reached the port with the CI failure source.
    expect(fake.reports.length).toBe(1);
    expect(fake.reports[0].source).toBe("ci-failure");
    expect(fake.reports[0].code).toBe("OBS-1019");
    // S7 (#5086): the CI rule now resolves through the catalog
    // (a real rule, OBS-1019 error) instead of the S4 placeholder.
    expect(fake.reports[0].ruleId).toBe("rule:ci-failure");
  });

  it("with alerting OFF the route still accepts (200) but nothing is delivered (no network call)", async () => {
    // Real port, alerting disabled: the port returns early
    // (no Slack/email attempt), so no real fetch is made.
    const res = await postAlert(
      makeEnv({ OTEL_ALERTING_ENABLED: "false" }),
      CI_ALERT,
      "test-ingest-token",
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { received?: boolean; delivered?: boolean };
    expect(body.received).toBe(true);
    expect(body.delivered).toBe(false);
  });

  it("404 when OTEL_INGEST_TOKEN is unset (the external surface is disabled)", async () => {
    const env = makeEnv({ OTEL_INGEST_TOKEN: undefined });
    const res = await postAlert(env, CI_ALERT, "test-ingest-token");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it("401 when the Bearer token is wrong", async () => {
    const res = await postAlert(makeEnv(), CI_ALERT, "wrong-token");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("401 when no Authorization header is sent", async () => {
    const res = await postAlert(makeEnv(), CI_ALERT);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("405 for a non-POST method", async () => {
    const res = await handleOtelRoutes(
      new Request(`https://agent.openaimp.com${OTEL_ALERTS_INGESTION_ROUTE}`, {
        method: "GET",
        headers: { Authorization: "Bearer test-ingest-token" },
      }),
      makeEnv(),
      new URL(`https://agent.openaimp.com${OTEL_ALERTS_INGESTION_ROUTE}`),
      OTEL_ALERTS_INGESTION_ROUTE,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(405);
  });

  it("a malformed body is rejected (400), never routed", async () => {
    const res = await postAlert(makeEnv(), { source: "ci-failure" }, "test-ingest-token");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });

  it("a non-ci-failure source is rejected (400) — this route is for CI failures only", async () => {
    const res = await postAlert(
      makeEnv(),
      { ...CI_ALERT, source: "sweep" },
      "test-ingest-token",
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });
});
