import { describe, it, expect, vi } from "vitest";
import { fetchScreenerPdf } from "../src/events/screenerPublishers";

/**
 * #333: fetchScreenerPdf must return a real PDF on a healthy path —
 * never null from a swallowed error.
 */

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF

function makeDeps(agent: unknown) {
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: () => agent,
  };
  return { env: { SCREENER_AGENT: ns }, userLogin: "tester" } as any;
}

// #3515 S3 batch 9: fetchScreenerPdf now logs via the structured
// logger, whose fallback sink writes every event as one JSON line via
// console.info. Parse those lines into structured events (batch-3
// pattern) instead of reading raw console.warn/error lines.
function structuredEvents(info: ReturnType<typeof vi.spyOn>): Array<{
  operation: string;
  level: string;
  fields: Record<string, unknown>;
}> {
  const events: Array<{
    operation: string;
    level: string;
    fields: Record<string, unknown>;
  }> = [];
  for (const call of info.mock.calls) {
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
  return events;
}

describe("#333 fetchScreenerPdf", () => {
  it("returns the run PDF by key on a healthy path", async () => {
    const agent = {
      getPdfByKey: async (key: string) =>
        key === "screener:pdf:a.pdf" ? { bytes: PDF_BYTES, fileName: "a.pdf" } : null,
      getLatestPdf: async () => null,
    };
    const pdf = await fetchScreenerPdf(makeDeps(agent), "screener:pdf:a.pdf");
    expect(pdf).not.toBeNull();
    expect(pdf!.fileName).toBe("a.pdf");
    expect(Array.from(pdf!.bytes.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it("returns null (never stale) when no key is given (#801)", async () => {
    const agent = {
      getPdfByKey: async () => null,
      getLatestPdf: async () => ({ bytes: PDF_BYTES, fileName: "latest.pdf" }),
    };
    const pdf = await fetchScreenerPdf(makeDeps(agent));
    // Issue #801: must NOT fall back to latest — a missing key means no attachment,
    // not someone else's report.
    expect(pdf).toBeNull();
  });

  it("logs the error and returns null when pdfStatus is failed (#822)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const agent = {
      getPdfByKey: async () => ({ bytes: PDF_BYTES, fileName: "should-not-fetch.pdf" }),
      getLatestPdf: async () => ({ bytes: PDF_BYTES, fileName: "latest.pdf" }),
    };
    const pdf = await fetchScreenerPdf(makeDeps(agent), undefined, "failed", "PDF lib crashed");
    expect(pdf).toBeNull();
    const failed = structuredEvents(info).filter(
      (e) => e.operation === "screenerPublishers.pdf_generation_failed"
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.level).toBe("error");
    expect(String(failed[0]?.fields?.message ?? "")).toContain("PDF generation failed");
    info.mockRestore();
  });

  it("returns null (not throw) when the agent errors, and logs it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const agent = {
      getPdfByKey: async () => {
        throw new Error("DO unreachable");
      },
      getLatestPdf: async () => null,
    };
    const pdf = await fetchScreenerPdf(makeDeps(agent), "k");
    expect(pdf).toBeNull();
    const failed = structuredEvents(info).filter(
      (e) => e.operation === "screenerPublishers.fetch_screener_pdf_failed"
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.level).toBe("warn");
    expect(failed[0]?.fields?.error).toBe("DO unreachable");
    info.mockRestore();
  });

  it("returns null with a warning when the binding is missing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const pdf = await fetchScreenerPdf({ env: {}, userLogin: "t" } as any, "k");
    expect(pdf).toBeNull();
    const missing = structuredEvents(info).filter(
      (e) => e.operation === "screenerPublishers.screener_agent_binding_missing"
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]?.level).toBe("warn");
    info.mockRestore();
  });
});
