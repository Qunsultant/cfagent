import { describe, it, expect, vi, afterEach } from "vitest";
import { createEmailSender } from "../src/services/cloudflareEmailSender";
import type { EmailSender } from "../src/services/emailSenderPorts";
import { createBrowserRenderer } from "../src/services/cloudflareBrowserRenderer";
import { ETradeEmailTradingService } from "../src/trading/email/agent";
import { ETradeBrowserService } from "../src/services/browserAgent";
import type { Env } from "../src/types";

/**
 * #1778 (Adapter S4, program #1717): one EmailSender port with a
 * Cloudflare EMAIL implementation, and one BrowserRenderer port with a
 * Cloudflare BROWSER implementation. Both paths are fail-soft today and
 * must stay fail-soft: an unbound binding resolves to false (email) or
 * to the HTTP-fetch fallback (browser), never to a throw.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fakeEmailBinding() {
  const sent: string[] = [];
  return {
    sent,
    binding: {
      async send(body: unknown) {
        // The adapter passes a ReadableStream body (Response.body);
        // read it back to text for assertion.
        const text = await new Response(body as BodyInit).text();
        sent.push(text);
      },
    },
  };
}

describe("EmailSender port (S4)", () => {
  it("createEmailSender returns null when EMAIL is unbound", () => {
    expect(createEmailSender({})).toBeNull();
    expect(createEmailSender(undefined)).toBeNull();
    expect(createEmailSender({ EMAIL: {} })).toBeNull();
  });

  it("sends a MIME message through the Cloudflare EMAIL binding", async () => {
    const fake = fakeEmailBinding();
    const sender: EmailSender | null = createEmailSender({ EMAIL: fake.binding });
    expect(sender).not.toBeNull();
    const ok = await sender!.send({
      to: "trader@example.com",
      subject: "Order preview",
      html: "<p>Preview</p>",
      text: "Preview",
    });
    expect(ok).toBe(true);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toContain("To: <trader@example.com>");
    expect(fake.sent[0]).toContain("Subject: Order preview");
    expect(fake.sent[0]).toContain("Preview");
    expect(fake.sent[0]).toContain("X-Agent-DID:");
  });

  it("uses EMAIL_AGENT_ADDRESS as From, defaulting to trade@agent.openaimp.com", async () => {
    const fake = fakeEmailBinding();
    const sender = createEmailSender({
      EMAIL: fake.binding,
      EMAIL_AGENT_ADDRESS: "desk@example.com",
    });
    await sender!.send({ to: "a@example.com", subject: "s", html: "h", text: "t" });
    expect(fake.sent[0]).toContain("desk@example.com");
    const fake2 = fakeEmailBinding();
    const sender2 = createEmailSender({ EMAIL: fake2.binding });
    await sender2!.send({ to: "a@example.com", subject: "s", html: "h", text: "t" });
    expect(fake2.sent[0]).toContain("trade@agent.openaimp.com");
  });

  it("carries attachments as base64 MIME parts", async () => {
    const fake = fakeEmailBinding();
    const sender = createEmailSender({ EMAIL: fake.binding });
    const ok = await sender!.send({
      to: "a@example.com",
      subject: "Report",
      html: "<p>R</p>",
      text: "R",
      attachments: [
        { fileName: "report.xlsx", contentType: "application/vnd.ms-excel", contentBase64: "QUJD" },
      ],
    });
    expect(ok).toBe(true);
    expect(fake.sent[0]).toContain("report.xlsx");
    expect(fake.sent[0]).toContain("QUJD");
  });

  it("returns false (warn, no throw) when the binding send throws", async () => {
    // #3515 S3: the send failure now travels as a structured
    // email.send_failed event (level warn) on the console-info JSON
    // fallback, not a console.warn line.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const sender = createEmailSender({
      EMAIL: { async send() { throw new Error("binding down"); } },
    });
    await expect(
      sender!.send({ to: "a@example.com", subject: "s", html: "h", text: "t" }),
    ).resolves.toBe(false);
    const events: Array<{ operation: string; level: string; fields: Record<string, unknown> }> = [];
    for (const call of infoSpy.mock.calls) {
      try {
        const parsed = JSON.parse(String(call[0])) as {
          operation?: unknown;
          level?: unknown;
          fields?: unknown;
        };
        if (parsed && typeof parsed.operation === "string") {
          events.push({
            operation: parsed.operation,
            level: typeof parsed.level === "string" ? parsed.level : "",
            fields:
              parsed.fields && typeof parsed.fields === "object"
                ? (parsed.fields as Record<string, unknown>)
                : {},
          });
        }
      } catch {
        // Non-JSON console.info lines are not structured events.
      }
    }
    const failed = events.find((e) => e.operation === "email.send_failed");
    expect(failed).toBeDefined();
    expect(failed?.level).toBe("warn");
    expect(String(failed?.fields.message ?? "")).toContain(
      "[ETradeEmailService] Failed to send email via env.EMAIL binding",
    );
    expect(String(failed?.fields.error ?? "")).toContain("binding down");
    infoSpy.mockRestore();
  });
});

describe("ETradeEmailTradingService.sendOutboundEmail via the port (S4)", () => {
  it("returns false, never throws, when EMAIL is unbound (fail-soft)", async () => {
    const svc = new ETradeEmailTradingService({} as Env);
    await expect(
      svc.sendOutboundEmail("a@example.com", "Hi", "<p>Hi</p>", "Hi"),
    ).resolves.toBe(false);
  });

  it("returns true through a bound EMAIL binding", async () => {
    const fake = fakeEmailBinding();
    const svc = new ETradeEmailTradingService({ EMAIL: fake.binding } as unknown as Env);
    await expect(
      svc.sendOutboundEmail("a@example.com", "Hi", "<p>Hi</p>", "Hi"),
    ).resolves.toBe(true);
    expect(fake.sent).toHaveLength(1);
  });

  it("returns false, never throws, when the bound send throws (fail-soft)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const svc = new ETradeEmailTradingService({
      EMAIL: { async send() { throw new Error("down"); } },
    } as unknown as Env);
    await expect(
      svc.sendOutboundEmail("a@example.com", "Hi", "<p>Hi</p>", "Hi"),
    ).resolves.toBe(false);
  });

  it("still rejects an invalid recipient/subject before reaching the port", async () => {
    const svc = new ETradeEmailTradingService({} as Env);
    await expect(
      svc.sendOutboundEmail("not-an-email", "Hi", "<p>Hi</p>", "Hi"),
    ).rejects.toThrow("Invalid outbound email recipient or subject.");
  });
});

describe("BrowserRenderer port (S4)", () => {
  it("createBrowserRenderer returns null when BROWSER is unbound", () => {
    expect(createBrowserRenderer({})).toBeNull();
    expect(createBrowserRenderer(undefined)).toBeNull();
    expect(createBrowserRenderer({ BROWSER: {} })).toBeNull();
  });

  it("renders through the Cloudflare BROWSER binding", async () => {
    const renderer = createBrowserRenderer({
      BROWSER: {
        async fetch(req: Request) {
          const body = await req.json();
          expect((body as { url: string }).url).toBe("https://example.com/p");
          return new Response(
            JSON.stringify({ title: "T", text: "page text", tables: [["a"]], screenshotBase64: "AAA" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      },
    });
    const out = await renderer!.render({ url: "https://example.com/p", screenshot: true });
    expect(out).toEqual({ title: "T", text: "page text", tables: [["a"]], screenshotBase64: "AAA" });
  });

  it("returns null on a non-OK render response and on a render throw (fail-soft)", async () => {
    const notOk = createBrowserRenderer({
      BROWSER: { async fetch() { return new Response("nope", { status: 500 }); } },
    });
    await expect(notOk!.render({ url: "https://example.com/p" })).resolves.toBeNull();
    const throwing = createBrowserRenderer({
      BROWSER: { async fetch() { throw new Error("render down"); } },
    });
    await expect(throwing!.render({ url: "https://example.com/p" })).resolves.toBeNull();
  });
});

describe("ETradeBrowserService.inspectPage via the port (S4)", () => {
  function stubHttpFetch(html: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => html })),
    );
  }

  it("uses the real capture path when BROWSER is bound", async () => {
    const svc = new ETradeBrowserService({
      BROWSER: {
        async fetch() {
          return new Response(
            JSON.stringify({ title: "Real", text: "rendered", tables: [], screenshotBase64: "CAP" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      },
    } as unknown as Env);
    const res = await svc.inspectPage({ url: "https://example.com/p", screenshot: true });
    expect(res.success).toBe(true);
    expect(res.screenshotKind).toBe("capture");
    expect(res.screenshotBase64).toBe("CAP");
  });

  it("falls back to HTTP fetch (placeholder, never a capture) when BROWSER is unbound", async () => {
    stubHttpFetch("<html><head><title>Fallback</title></head><body><p>hello</p></body></html>");
    const svc = new ETradeBrowserService({} as unknown as Env);
    const res = await svc.inspectPage({ url: "https://example.com/p", screenshot: true });
    expect(res.success).toBe(true);
    expect(res.title).toBe("Fallback");
    expect(res.screenshotKind).toBe("placeholder");
  });

  it("falls back to HTTP fetch when the bound render throws", async () => {
    stubHttpFetch("<html><head><title>Fallback</title></head><body><p>hello</p></body></html>");
    const svc = new ETradeBrowserService({
      BROWSER: { async fetch() { throw new Error("render down"); } },
    } as unknown as Env);
    const res = await svc.inspectPage({ url: "https://example.com/p" });
    expect(res.success).toBe(true);
    expect(res.title).toBe("Fallback");
  });

  it("falls back to HTTP fetch when the bound render is not OK", async () => {
    stubHttpFetch("<html><head><title>Fallback</title></head><body><p>hello</p></body></html>");
    const svc = new ETradeBrowserService({
      BROWSER: { async fetch() { return new Response("err", { status: 502 }); } },
    } as unknown as Env);
    const res = await svc.inspectPage({ url: "https://example.com/p" });
    expect(res.success).toBe(true);
    expect(res.title).toBe("Fallback");
  });
});
