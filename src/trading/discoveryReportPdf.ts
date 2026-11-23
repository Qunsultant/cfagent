/**
 * Discovery-run PDF (#2180).
 *
 * A discovery run is a batch: many symbols, each with a verdict. The PDF is
 * the read-and-share artifact for that batch — header + counts, then one
 * block per symbol (what ran, the judged pick and its economics/legs, or the
 * recorded reason), capped with a visible "showing X of Y" when a run is
 * unusually large.
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { discoverySymbolRows, type DiscoveryReportInput } from "./discoveryReportData";
import { cleanForPdf } from "./pdfText";

const MARGIN = 48;
const PAGE_W = 612;
const PAGE_H = 792;
const MAX_SYMBOLS = 200;

function num(value: string | number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: string | number | null): string {
  return value === null ? "" : String(value);
}

function money(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(2)}`;
}

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export async function generateDiscoveryReportPdf(input: DiscoveryReportInput): Promise<Uint8Array> {
  const rows = discoverySymbolRows(input);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const ensure = (needed: number) => {
    if (y - needed < MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };

  const text = (value: string, size = 10, useBold = false, color = rgb(0, 0, 0), indent = 0) => {
    const maxWidth = PAGE_W - MARGIN * 2 - indent;
    // #5109 — WinAnsi-sanitize before measuring (see ./pdfText).
    const words = cleanForPdf(value).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    for (const rendered of lines.length > 0 ? lines : [""]) {
      ensure(size + 6);
      page.drawText(rendered, { x: MARGIN + indent, y, size, font: useBold ? bold : font, color });
      y -= size + 5;
    }
  };

  const rule = () => {
    ensure(12);
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 0.6,
      color: rgb(0.82, 0.82, 0.82),
    });
    y -= 10;
  };

  text(`Strategy discovery — ${input.inputModel || "run"}`, 17, true);
  text(
    [
      `Run ${input.runId}`,
      `Trigger: ${input.trigger}`,
      `Status: ${input.status}`,
      `Created: ${input.createdAt}`,
      `${input.symbols?.length ?? rows.length} symbol(s)`,
    ].join("  ·  "),
    9,
    false,
    rgb(0.42, 0.42, 0.42),
  );
  if (input.summary) text(input.summary, 10);
  text(
    `Matched ${input.matchedCount ?? "—"} of ${input.totalScanned ?? "—"} · ` +
      `fit ${rows.filter((row) => row.verdict === "fit").length}, ` +
      `no trade ${rows.filter((row) => row.verdict === "no_trade").length}, ` +
      `abstained ${rows.filter((row) => row.verdict === "abstained").length}, ` +
      `failed ${rows.filter((row) => row.verdict === "failed").length}`,
    9,
    false,
    rgb(0.42, 0.42, 0.42),
  );
  rule();

  if (rows.length === 0) text("No symbols were attempted in this run.", 11, true);

  const shown = rows.slice(0, MAX_SYMBOLS);
  if (rows.length > shown.length) {
    text(`Showing ${shown.length} of ${rows.length} symbols — the workbook and CSV carry every row.`, 9, false, rgb(0.55, 0.35, 0));
  }

  for (const row of shown) {
    ensure(84);
    text(`${row.symbol} — ${String(row.verdict).replaceAll("_", " ")} — ${row.best_strategy}`, 12, true);
    text(str(row.input), 9, false, rgb(0.42, 0.42, 0.42));
    if (row.verdict === "fit" || row.verdict === "no_trade") {
      text(
        [
          `Strategy: ${row.best_strategy}`,
          row.expiration ? `Expiry: ${row.expiration}` : null,
          `Ranked: ${row.ranked}`,
          row.score === null ? null : `Score: ${row.score}`,
          `POP: ${pct(num(row.probability_of_profit))}`,
          `Max profit: ${money(num(row.max_profit))}`,
          `Max loss: ${money(num(row.max_loss))}`,
        ]
          .filter(Boolean)
          .join("  ·  "),
        9,
      );
      if (row.legs) text(str(row.legs), 9, false, rgb(0.25, 0.25, 0.25), 8);
    }
    if (row.reason) {
      text(
        `Reason: ${str(row.reason)}`,
        row.verdict === "failed" ? 9 : 8,
        false,
        row.verdict === "failed" ? rgb(0.72, 0.2, 0.2) : rgb(0.42, 0.42, 0.42),
        8,
      );
    }
    rule();
  }

  const pages = doc.getPages();
  pages.forEach((p, index) => {
    p.drawText(`${index + 1} / ${pages.length}`, {
      x: PAGE_W - MARGIN - 40,
      y: 24,
      size: 8,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });
  });

  return doc.save();
}

