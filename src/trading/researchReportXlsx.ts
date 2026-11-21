/**
 * Research-run workbook (#2167).
 *
 * One workbook per research run, rendered from the shared row model in
 * `researchReportData.ts` — the same projection the CSV and the PDF use:
 *
 *  - `Ideas`       the ranked economics table (identical to the CSV)
 *  - `Legs`        one row per option leg, with the side from the sign
 *  - `Trade Cards` the per-idea narrative: thesis, evidence, falsification
 *  - `Watchlist`   names waiting on a trigger
 *  - `Rejected`    names the gates rejected, with the gate and the reason
 *  - `Run Summary` run identity, stats and the effective config snapshot
 *
 * An empty run still produces a valid workbook with headers on every tab —
 * a missing document must never be confused with an empty one.
 */

import * as XLSX from "@e965/xlsx";
import type { ResearchReport } from "../services/researchPipeline";
import {
  RESEARCH_IDEA_COLUMNS,
  RESEARCH_TRADE_CARD_COLUMNS,
  researchIdeaRows,
  researchLegRows,
  researchRejectedRows,
  RESEARCH_SYMBOL_EVALUATION_COLUMNS,
  researchSymbolEvaluationRows,
  researchSummaryRows,
  researchTradeCardRows,
  researchWatchlistRows,
} from "./researchReportData";

const LEG_COLUMNS = [
  "idea_rank",
  "symbol",
  "side",
  "quantity",
  "option_type",
  "strike",
  "expiry",
  "dte",
  "bid",
  "ask",
  "mid",
  "implied_volatility",
  "volume",
  "open_interest",
] as const;

const WATCHLIST_COLUMNS = ["symbol", "outlook", "structure", "thesis", "reason", "trigger_condition"] as const;

const REJECTED_COLUMNS = ["symbol", "outlook", "structure", "gate", "reason"] as const;

function sheet<T extends Record<string, unknown>>(rows: T[], header: readonly string[]): XLSX.WorkSheet {
  return XLSX.utils.json_to_sheet(rows, { header: header as string[] });
}

export function generateResearchReportXlsx(report: ResearchReport): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(researchIdeaRows(report), RESEARCH_IDEA_COLUMNS), "Ideas");
  XLSX.utils.book_append_sheet(wb, sheet(researchLegRows(report) as any, LEG_COLUMNS), "Legs");
  XLSX.utils.book_append_sheet(
    wb,
    sheet(researchTradeCardRows(report), RESEARCH_TRADE_CARD_COLUMNS),
    "Trade Cards",
  );
  XLSX.utils.book_append_sheet(wb, sheet(researchWatchlistRows(report) as any, WATCHLIST_COLUMNS), "Watchlist");
  XLSX.utils.book_append_sheet(wb, sheet(researchRejectedRows(report) as any, REJECTED_COLUMNS), "Rejected");
  XLSX.utils.book_append_sheet(wb, sheet(researchSymbolEvaluationRows(report), RESEARCH_SYMBOL_EVALUATION_COLUMNS), "Symbol Evaluations");

  const summary = XLSX.utils.aoa_to_sheet([["field", "value"], ...researchSummaryRows(report)]);
  XLSX.utils.book_append_sheet(wb, summary, "Run Summary");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as unknown as Uint8Array;
}
