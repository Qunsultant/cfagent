/**
 * Issue #2599 (F8): the options PDF wraps long lines instead of
 * truncating them at 120 characters.
 *
 * pdf-lib writes drawn text as hex Tj strings inside Flate
 * streams, so this test inflates the streams and hex-decodes
 * the Tj strings, then asserts a marker placed past character
 * 120 of one rendered line is present in the PDF. Under the old
 * slice(0, 120) rendering the marker could never appear.
 */
import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { generateOptionsPdf } from "../src/trading/optionsReportPdf";

function pdfDrawnText(bytes: Uint8Array): string {
  const latin = Buffer.from(bytes).toString("latin1");
  const decoded: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(latin)) !== null) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
    } catch {
      continue;
    }
    const tjRe = /<([0-9A-Fa-f]+)>\s*Tj/g;
    let t: RegExpExecArray | null;
    while ((t = tjRe.exec(content)) !== null) {
      decoded.push(Buffer.from(t[1], "hex").toString("latin1"));
    }
  }
  return decoded.join("\n");
}

describe("options PDF word wrap (#2599 F8)", () => {
  it("renders text past character 120 of a long line (wrap, not truncate)", async () => {
    const tail = "TAILMARKER";
    // 150+ characters before the marker: under slice(0, 120) the
    // marker would be cut off; wrapped, it lands on a later line.
    const description =
      "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega " +
      "alpha beta gamma delta epsilon zeta eta theta iota kappa " +
      tail;
    expect(description.indexOf(tail)).toBeGreaterThan(120);
    const bytes = await generateOptionsPdf({
      scanned: 1,
      withTrades: 0,
      opportunities: [
        {
          symbol: "TSLA",
          underlyingPrice: 250,
          pick: { strategyName: "Probe", description },
        },
      ],
      generatedAt: "2026-10-21T06:00:00.000Z",
    } as any);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
    const text = pdfDrawnText(bytes);
    expect(text).toContain("Alpha beta gamma");
    expect(text).toContain(tail);
  });

  it("still renders a short line intact", async () => {
    const bytes = await generateOptionsPdf({
      scanned: 1,
      withTrades: 0,
      opportunities: [
        {
          symbol: "TSLA",
          underlyingPrice: 250,
          pick: { strategyName: "Probe", description: "Short line" },
        },
      ],
      generatedAt: "2026-10-21T06:00:00.000Z",
    } as any);
    expect(pdfDrawnText(bytes)).toContain("Short line");
  });
});
