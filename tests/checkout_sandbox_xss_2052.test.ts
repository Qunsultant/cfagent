/**
 * Issue #2052 — reflected XSS on the public /checkout/sandbox page.
 * Owner decision 2026-11-01: KEEP PUBLIC. The fix escapes the five
 * attacker-controlled query params (provider, customer, amount,
 * currency, sig) at their HTML interpolation points and adds a CSP
 * header; the route stays public and ungated.
 *
 * These tests go through the worker's default fetch export (the real
 * handleFetch dispatch) with no session and no token, and assert on
 * the response body — no payload is executed anywhere.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import worker from "../src/server";

const fetchSandbox = async (qs: string) => {
  const res = await worker.fetch(
    new Request(`https://agent.test/checkout/sandbox${qs}`, { method: "GET" }),
    {} as any,
  );
  return { res, text: await res.text() };
};

describe("/checkout/sandbox escaping (#2052, KEEP PUBLIC)", () => {
  it("escapes a script tag in provider (uppercased by the handler)", async () => {
    const payload = "<script>alert(1)</script>";
    const { text } = await fetchSandbox(`?provider=${encodeURIComponent(payload)}`);
    expect(text).toContain("&lt;SCRIPT&gt;ALERT(1)&lt;/SCRIPT&gt;");
    expect(text).not.toContain("<SCRIPT>");
    expect(text).not.toContain("<script>");
  });

  it("escapes a quote breakout + event handler in customer", async () => {
    const payload = `"><img src=x onerror=alert(1)>`;
    const { text } = await fetchSandbox(`?cust=${encodeURIComponent(payload)}`);
    expect(text).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(text).not.toContain("<img src=x");
  });

  it("escapes markup in amount", async () => {
    const payload = "<svg onload=alert(1)>";
    const { text } = await fetchSandbox(`?amt=${encodeURIComponent(payload)}`);
    expect(text).toContain("&lt;svg onload=alert(1)&gt;");
    expect(text).not.toContain("<svg");
  });

  it("escapes quotes in currency", async () => {
    const payload = `USD" onmouseover="alert(1)`;
    const { text } = await fetchSandbox(`?curr=${encodeURIComponent(payload)}`);
    expect(text).toContain("USD&quot; onmouseover=&quot;alert(1)");
    expect(text).not.toContain(`onmouseover="alert`);
  });

  it("escapes a script tag in sig", async () => {
    const payload = "<script>alert(2)</script>";
    const { text } = await fetchSandbox(`?sig=${encodeURIComponent(payload)}`);
    expect(text).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(text).not.toContain("<script>");
  });

  it("escapes ampersands (escape order: & first)", async () => {
    const { text } = await fetchSandbox(`?cust=${encodeURIComponent("Tom & Jerry")}`);
    expect(text).toContain("Tom &amp; Jerry");
  });

  it("sends a Content-Security-Policy header and keeps text/html", async () => {
    const { res } = await fetchSandbox("");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("stays public: no session, no token, still 200 (KEEP PUBLIC)", async () => {
    const { res } = await fetchSandbox("");
    expect(res.status).toBe(200);
  });

  it("benign rendering is unchanged for default params", async () => {
    const { text } = await fetchSandbox("");
    expect(text).toContain("STRIPE Sandbox Terminal");
    expect(text).toContain("$25.00");
    expect(text).toContain("Enterprise Customer");
  });

  it("keeps the Authorize href URL-encoded, not double-escaped", async () => {
    const { text } = await fetchSandbox(`?provider=${encodeURIComponent("a&b")}`);
    expect(text).toContain("provider=A%26B");
    expect(text).not.toContain("provider=A&amp;B");
  });
});
