/**
 * Issue #2041 S4 — saga outcome notices (gap G-OUTCOME-NOTICE).
 *
 * TDD: written before the notice module. A terminal saga outcome
 * is noticed through the EXISTING delivery channels: a Slack text
 * post (mirroring the journey-prompt post) plus the UI row the
 * status route already serves. The notice resolves its copy from
 * the single outcome catalog (businessMessage → channels, never
 * inline strings). A failed post is a visible failed receipt,
 * never a thrown error and never a silent absence. Email is NOT
 * built here: saga outcomes have no report-backed delivery path
 * to ride, and the brief allows email only on existing delivery.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildSagaOutcomeNotice,
  postSlackSagaOutcome,
  type SagaOutcomeNotice,
} from "../src/workflows/sagaOutcomeNotice";

afterEach(() => {
  vi.unstubAllGlobals();
});

function noticeFor(code: string): SagaOutcomeNotice {
  return buildSagaOutcomeNotice({
    sagaId: "saga-1",
    runRequestId: "run-1",
    outcomeCode: code,
    statusUrl: "/api/saga/saga-1/status",
  });
}

describe("saga outcome notice copy (S4, #2041)", () => {
  it.each([
    "SUCCESS_SAGA_TRADE_SETTLED",
    "FAILURE_SAGA_TRADE_REJECTED",
    "FAILURE_SAGA_TRADE_EXPIRED",
    "FAILURE_SAGA_TRADE_LEG_FAILED",
    "FAILURE_SAGA_PROPOSAL_FAILED",
    "FAILURE_SAGA_PAYMENT_NOT_COMPLETED",
    "FAILURE_SAGA_JOURNEY_DENIED",
  ])("resolves %s from the catalog (businessMessage, never an inline string)", (code) => {
    const notice = noticeFor(code);
    expect(notice.code).toBe(code);
    expect(notice.text).toContain(`[${code}]`);
    expect(notice.text).toContain("saga-1");
    expect(notice.text).toContain("/api/saga/saga-1/status");
    expect(notice.text.length).toBeGreaterThan(code.length + 10);
  });

  it("carries the catalog businessMessage verbatim for a settled trade", () => {
    const notice = noticeFor("SUCCESS_SAGA_TRADE_SETTLED");
    expect(notice.text).toContain("The trade leg settled");
  });

  it("does not invent a code for an unknown outcome: the raw code stays visible", () => {
    const notice = noticeFor("FAILURE_SAGA_NOPE");
    expect(notice.code).toBe("FAILURE_SAGA_NOPE");
    expect(notice.text).toContain("FAILURE_SAGA_NOPE");
    expect(notice.text).not.toContain("SUCCESS_SAGA_TRADE_SETTLED");
  });
});

describe("postSlackSagaOutcome (S4, #2041)", () => {
  const env = {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_CHANNEL: "C123",
  };

  it("skips without a token (never throws, receipt says why)", async () => {
    const receipt = await postSlackSagaOutcome(
      noticeFor("SUCCESS_SAGA_TRADE_SETTLED"),
      {},
    );
    expect(receipt.slack).toBe("skipped");
    expect(receipt.slackDetail).toMatch(/token/);
  });

  it("posts the notice text and returns the channel + ts", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, ts: "1700000000.000001" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const receipt = await postSlackSagaOutcome(
      noticeFor("SUCCESS_SAGA_TRADE_SETTLED"),
      env,
    );
    expect(receipt.slack).toBe("posted");
    expect(receipt.slackChannel).toBe("C123");
    expect(receipt.slackTs).toBe("1700000000.000001");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("slack.com/api/chat.postMessage");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.channel).toBe("C123");
    expect(body.text).toContain("SUCCESS_SAGA_TRADE_SETTLED");
  });

  it("a non-ok Slack response is a failed receipt, never a throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("error", { status: 500 })),
    );
    const receipt = await postSlackSagaOutcome(
      noticeFor("FAILURE_SAGA_TRADE_LEG_FAILED"),
      env,
    );
    expect(receipt.slack).toBe("failed");
    expect(receipt.slackDetail).toBeDefined();
  });

  it("a throwing fetch is a failed receipt, never a throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const receipt = await postSlackSagaOutcome(
      noticeFor("FAILURE_SAGA_TRADE_LEG_FAILED"),
      env,
    );
    expect(receipt.slack).toBe("failed");
  });
});
